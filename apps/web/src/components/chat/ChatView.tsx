/**
 * A text channel or DM conversation: header, message list, typing row, composer.
 *
 * Message *grouping* is decided here rather than in `MessageItem` because it depends on
 * the neighbouring message — an item cannot know whether it continues a run.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowDown, Hash, Menu, Pin, Search, Users } from 'lucide-react';
import clsx from 'clsx';
import type { Message } from '@rockscord/shared';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { useChannelMessages } from '../../hooks/useChannelMessages';
import { Avatar } from '../ui/Avatar';
import { EmptyState, IconButton, Spinner } from '../ui/primitives';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';
import { TypingRow } from './TypingRow';

/** Messages within this window from the same author are visually grouped. */
const GROUP_WINDOW_MS = 7 * 60 * 1000;

function sameDay(a: number, b: number): boolean {
  const dateA = new Date(a);
  const dateB = new Date(b);
  return (
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

function dayLabel(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);

  if (sameDay(timestamp, today.getTime())) return 'Today';
  if (sameDay(timestamp, yesterday.getTime())) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

export function ChatView({ channelId }: { channelId: string }) {
  const channel = useAppStore((s) => s.channels[channelId]);
  const dm = useAppStore((s) => s.dmChannels[channelId]);
  const readState = useAppStore((s) => s.readStates[channelId]);
  const presence = useAppStore((s) => s.presence);

  const toggleMemberList = useUiStore((s) => s.toggleMemberList);
  const setMobilePane = useUiStore((s) => s.setMobilePane);
  const openModal = useUiStore((s) => s.openModal);

  const {
    messages,
    loaded,
    loading,
    hasMore,
    scrollRef,
    isPinnedToBottom,
    scrollToBottom,
    jumpTo,
  } = useChannelMessages(channelId);

  const serverId = channel?.serverId || null;

  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useUiStore((s) => s.toast);

  const handleJump = useCallback(
    (messageId: string) => {
      void jumpTo(messageId).then((found) => {
        if (!found) toast('Could not find that message', 'error');
      });
    },
    [jumpTo, toast],
  );

  /*
   * `?m=<id>` in the URL means "open this channel at this message" -- what a copied link
   * and a search result both produce. The parameter is stripped once used, so a refresh
   * or a later scroll does not yank the view back to it.
   */
  const target = searchParams.get('m');
  useEffect(() => {
    if (!target || !channelId) return;
    void jumpTo(target).then((found) => {
      if (!found) toast('That message is no longer here', 'error');
      setSearchParams(
        (params) => {
          params.delete('m');
          return params;
        },
        { replace: true },
      );
    });
  }, [target, channelId, jumpTo, setSearchParams, toast]);

  /**
   * Decide grouping and day dividers in one pass.
   * The unread divider is placed above the first message newer than the last-read id —
   * captured once on entry so it does not jump as new messages arrive.
   */
  const rows = useMemo(() => {
    const lastRead = readState?.lastReadMessageId ?? null;
    let dividerPlaced = false;

    return messages.map((message, index) => {
      const previous = index > 0 ? messages[index - 1] : undefined;

      const newDay = !previous || !sameDay(previous.createdAt, message.createdAt);

      const grouped =
        !newDay &&
        Boolean(previous) &&
        previous!.authorId === message.authorId &&
        !previous!.deleted &&
        !message.replyToId &&
        message.createdAt - previous!.createdAt < GROUP_WINDOW_MS;

      let showUnreadDivider = false;
      if (!dividerPlaced && lastRead && message.id > lastRead) {
        showUnreadDivider = true;
        dividerPlaced = true;
      }

      return { message, grouped: grouped && !showUnreadDivider, newDay, showUnreadDivider };
    });
  }, [messages, readState?.lastReadMessageId]);

  const title = channel?.name ?? dm?.recipients.map((r) => r.displayName).join(', ') ?? 'Channel';
  const recipient = dm?.recipients[0];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header ---------------------------------------------------------- */}
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3 shadow-sm">
        <IconButton
          label="Show channels"
          onClick={() => setMobilePane('sidebar')}
          className="md:hidden"
        >
          <Menu size={18} />
        </IconButton>

        {dm && recipient ? (
          <Avatar
            userId={recipient.id}
            name={recipient.displayName}
            src={recipient.avatarUrl}
            size={24}
            status={presence[recipient.id]?.status ?? 'offline'}
            showStatus
          />
        ) : (
          <Hash size={20} className="shrink-0 text-ink-faint" />
        )}

        <h1 className="shrink-0 truncate text-[15px] font-semibold text-ink">{title}</h1>

        {channel?.topic && (
          <>
            <div className="mx-1 h-5 w-px shrink-0 bg-line" />
            <p className="truncate text-[13px] text-ink-faint" title={channel.topic}>
              {channel.topic}
            </p>
          </>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          <IconButton
            label="Pinned messages"
            onClick={() => openModal({ kind: 'search', channelId })}
          >
            <Pin size={17} />
          </IconButton>
          <IconButton
            label="Search"
            onClick={() =>
              openModal({ kind: 'search', serverId: serverId ?? undefined, channelId })
            }
          >
            <Search size={17} />
          </IconButton>
          {serverId && (
            <IconButton label="Toggle member list" onClick={toggleMemberList}>
              <Users size={18} />
            </IconButton>
          )}
        </div>
      </header>

      {/* Messages -------------------------------------------------------- */}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="scrollbar-slim h-full overflow-y-auto pb-2">
          {loading && !loaded && (
            <div className="flex h-full items-center justify-center text-ink-faint">
              <Spinner size={22} />
            </div>
          )}

          {loaded && messages.length === 0 && (
            <EmptyState
              icon={<Hash size={44} />}
              title={dm ? `This is the start of your conversation` : `Welcome to #${title}`}
              body={
                dm
                  ? 'Say something to get things going.'
                  : 'This is the beginning of this channel. Send the first message.'
              }
            />
          )}

          {loaded && messages.length > 0 && (
            <>
              {/* Channel intro, shown once all history is loaded. */}
              {!hasMore && (
                <div className="px-4 pb-4 pt-8">
                  <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-surface-3">
                    <Hash size={34} className="text-ink-dim" />
                  </div>
                  <h2 className="text-2xl font-bold text-ink">
                    {dm ? title : `Welcome to #${title}`}
                  </h2>
                  <p className="mt-1 text-[14px] text-ink-dim">
                    {dm
                      ? 'This is the beginning of your direct message history.'
                      : `This is the start of the #${title} channel.`}
                  </p>
                </div>
              )}

              {hasMore && (
                <div className="flex justify-center py-4">
                  <Spinner size={18} className="text-ink-faint" />
                </div>
              )}

              {rows.map(({ message, grouped, newDay, showUnreadDivider }) => (
                <div key={message.id}>
                  {newDay && <DayDivider timestamp={message.createdAt} />}
                  <MessageItem
                    message={message}
                    grouped={grouped}
                    channelId={channelId}
                    serverId={serverId}
                    showUnreadDivider={showUnreadDivider}
                    onJumpTo={handleJump}
                  />
                </div>
              ))}
            </>
          )}
        </div>

        {/* Jump-to-latest, shown only when scrolled away from the bottom. */}
        <JumpToBottom
          messages={messages}
          isPinned={isPinnedToBottom}
          onClick={() => scrollToBottom('smooth')}
        />
      </div>

      <TypingRow channelId={channelId} />

      <Composer
        channelId={channelId}
        serverId={serverId}
        placeholder={dm ? `Message ${title}` : `Message #${title}`}
      />
    </div>
  );
}

function DayDivider({ timestamp }: { timestamp: number }) {
  return (
    <div className="my-4 flex items-center gap-3 px-4" role="separator">
      <div className="h-px flex-1 bg-line" />
      <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        {dayLabel(timestamp)}
      </span>
      <div className="h-px flex-1 bg-line" />
    </div>
  );
}

/**
 * The scroll position lives in a ref (it changes on every scroll frame and must not
 * re-render the list), so this polls it on an interval instead of subscribing.
 */
function JumpToBottom({
  messages,
  isPinned,
  onClick,
}: {
  messages: Message[];
  isPinned: React.RefObject<boolean>;
  onClick: () => void;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setVisible(!isPinned.current && messages.length > 0);
    }, 250);
    return () => window.clearInterval(interval);
  }, [isPinned, messages.length]);

  if (!visible) return null;

  return (
    <button
      onClick={onClick}
      className={clsx(
        'animate-fade-in absolute bottom-3 right-5 flex items-center gap-1.5 rounded-full',
        'border border-line-strong bg-surface-4 px-3 py-1.5 text-[13px] text-ink-dim shadow-pop',
        'transition-colors hover:text-ink',
      )}
    >
      <ArrowDown size={14} />
      Jump to latest
    </button>
  );
}
