/**
 * Message loading for a channel.
 *
 * Handles the initial page, "load older" as the user scrolls up, socket subscription, and
 * read acknowledgement.
 *
 * The subtle part is **scroll anchoring**. When older messages are prepended, the browser
 * keeps `scrollTop` the same — but the content above the viewport just got taller, so the
 * user appears to jump backwards. The fix is to record `scrollHeight` before the insert
 * and add the delta afterwards, in a layout effect so it happens before paint.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { Message, PaginatedMessages } from '@rockscord/shared';
import { api } from '../lib/api';
import { ackRead, subscribeToChannel, unsubscribeFromChannel } from '../lib/socket';
import { EMPTY_ARRAY, useAppStore } from '../store/useAppStore';

interface UseChannelMessagesResult {
  messages: Message[];
  loading: boolean;
  loaded: boolean;
  hasMore: boolean;
  loadOlder: () => Promise<void>;
  /** Attach to the scrollable element so pagination and anchoring can work. */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to a sentinel div at the very bottom of the list. */
  bottomRef: React.RefObject<HTMLDivElement | null>;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** True when the user has scrolled up away from the newest message. */
  isPinnedToBottom: React.RefObject<boolean>;
}

/** How close to the bottom still counts as "at the bottom", in pixels. */
const BOTTOM_THRESHOLD = 120;
/** Distance from the top that triggers loading the previous page. */
const TOP_TRIGGER = 240;

export function useChannelMessages(channelId: string | null): UseChannelMessagesResult {
  const messages = useAppStore((s) =>
    channelId
      ? (s.messagesByChannel[channelId] ?? EMPTY_ARRAY)
      : EMPTY_ARRAY,
  );
  const paging = useAppStore((s) => (channelId ? s.paging[channelId] : undefined));
  const setMessages = useAppStore((s) => s.setMessages);
  const prependMessages = useAppStore((s) => s.prependMessages);
  const setPaging = useAppStore((s) => s.setPaging);
  const markRead = useAppStore((s) => s.markRead);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const isPinnedToBottom = useRef(true);
  /** scrollHeight captured immediately before a prepend, for anchoring. */
  const anchorHeight = useRef<number | null>(null);
  const loadingOlder = useRef(false);

  const loaded = paging?.loaded ?? false;
  const loading = paging?.loading ?? false;
  const hasMore = paging?.hasMore ?? true;

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  /* -------------------------------------------------------------------- */
  /* Initial load + subscription                                           */
  /* -------------------------------------------------------------------- */

  useEffect(() => {
    if (!channelId) return;

    subscribeToChannel(channelId);
    isPinnedToBottom.current = true;

    const alreadyLoaded = useAppStore.getState().paging[channelId]?.loaded;
    if (alreadyLoaded) {
      // Returning to a channel we already have: jump to the bottom without refetching.
      requestAnimationFrame(() => scrollToBottom());
      return () => unsubscribeFromChannel(channelId);
    }

    let cancelled = false;
    setPaging(channelId, { loading: true });

    api
      .get<PaginatedMessages>(`/api/channels/${channelId}/messages?limit=50`)
      .then((response) => {
        if (cancelled) return;
        setMessages(channelId, response.messages, response.hasMore);
        // Two frames: one for React to commit, one for layout to settle.
        requestAnimationFrame(() => requestAnimationFrame(() => scrollToBottom()));
      })
      .catch(() => {
        if (!cancelled) setPaging(channelId, { loading: false, loaded: true, hasMore: false });
      });

    return () => {
      cancelled = true;
      unsubscribeFromChannel(channelId);
    };
  }, [channelId, setMessages, setPaging, scrollToBottom]);

  /* -------------------------------------------------------------------- */
  /* Load older                                                            */
  /* -------------------------------------------------------------------- */

  const loadOlder = useCallback(async () => {
    if (!channelId || loadingOlder.current) return;

    const state = useAppStore.getState();
    const current = state.messagesByChannel[channelId] ?? [];
    const pagingState = state.paging[channelId];

    if (!pagingState?.hasMore || pagingState.loading) return;

    const oldest = current[0];
    if (!oldest) return;

    loadingOlder.current = true;
    setPaging(channelId, { loading: true });
    anchorHeight.current = scrollRef.current?.scrollHeight ?? null;

    try {
      const response = await api.get<PaginatedMessages>(
        `/api/channels/${channelId}/messages?before=${oldest.id}&limit=50`,
      );
      prependMessages(channelId, response.messages, response.hasMore);
    } catch {
      setPaging(channelId, { loading: false });
    } finally {
      loadingOlder.current = false;
    }
  }, [channelId, prependMessages, setPaging]);

  /**
   * Restore the scroll position after a prepend. This runs as a plain effect rather than
   * useLayoutEffect on the message array because the DOM height only settles after images
   * in the new page reserve their space, which the width/height attributes make immediate.
   */
  useEffect(() => {
    if (anchorHeight.current === null) return;
    const element = scrollRef.current;
    if (!element) {
      anchorHeight.current = null;
      return;
    }
    const delta = element.scrollHeight - anchorHeight.current;
    if (delta > 0) element.scrollTop += delta;
    anchorHeight.current = null;
  }, [messages.length]);

  /* -------------------------------------------------------------------- */
  /* Follow new messages                                                   */
  /* -------------------------------------------------------------------- */

  useEffect(() => {
    if (!channelId || messages.length === 0) return;

    // Only auto-scroll when the user is already at the bottom. Yanking someone back down
    // while they are reading history is the worst thing a chat app can do.
    if (isPinnedToBottom.current) {
      requestAnimationFrame(() => scrollToBottom());
    }

    const newest = messages[messages.length - 1]!;
    const readState = useAppStore.getState().readStates[channelId];

    // Acknowledge only what we can actually see.
    if (isPinnedToBottom.current && readState?.lastReadMessageId !== newest.id) {
      ackRead(channelId, newest.id);
      markRead(channelId, newest.id);
    }
  }, [channelId, messages, scrollToBottom, markRead]);

  /* -------------------------------------------------------------------- */
  /* Scroll tracking                                                       */
  /* -------------------------------------------------------------------- */

  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !channelId) return;

    const onScroll = () => {
      const distanceFromBottom =
        element.scrollHeight - element.scrollTop - element.clientHeight;
      isPinnedToBottom.current = distanceFromBottom < BOTTOM_THRESHOLD;

      if (element.scrollTop < TOP_TRIGGER) void loadOlder();

      // Coming back to the bottom marks the channel read.
      if (isPinnedToBottom.current) {
        const state = useAppStore.getState();
        const list = state.messagesByChannel[channelId] ?? [];
        const newest = list[list.length - 1];
        if (newest && state.readStates[channelId]?.lastReadMessageId !== newest.id) {
          ackRead(channelId, newest.id);
          markRead(channelId, newest.id);
        }
      }
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [channelId, loadOlder, markRead]);

  return {
    messages,
    loading,
    loaded,
    hasMore,
    loadOlder,
    scrollRef,
    bottomRef,
    scrollToBottom,
    isPinnedToBottom,
  };
}
