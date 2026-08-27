/**
 * Ctrl/Cmd+K — jump to any channel, DM, or server by typing.
 *
 * Once someone is in more than two or three servers, the sidebar stops being a way to
 * find things and becomes a way to browse them. This is the keyboard path: type three
 * letters, press Enter.
 *
 * It is deliberately not the message search. Search answers "where was that said"; this
 * answers "take me there", and conflating them makes both slower — this needs no network
 * round trip at all, because everything it can match is already in the store.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hash, MessagesSquare, Volume2 } from 'lucide-react';
import clsx from 'clsx';
import { useAppStore } from '../../store/useAppStore';
import { Avatar } from '../ui/Avatar';

interface Entry {
  id: string;
  kind: 'text' | 'voice' | 'dm' | 'server';
  /** What is matched against and displayed. */
  label: string;
  /** Server name for a channel, or the handle for a DM. */
  context: string | null;
  path: string;
  /** For DM rows, so a face can be shown instead of an icon. */
  userId?: string;
  avatarUrl?: string | null;
}

/**
 * Subsequence match, the way editors do it: "gnrl" finds "general".
 *
 * Returns a score (lower is better) or null for no match. Consecutive characters and
 * matches at the start of the name score better, so typing "gen" puts "general" above
 * "assignments" even though both contain the letters in order.
 */
function fuzzyScore(text: string, query: string): number | null {
  if (!query) return 0;

  const haystack = text.toLowerCase();
  let score = 0;
  let position = 0;
  let previous = -1;

  for (const character of query.toLowerCase()) {
    const found = haystack.indexOf(character, position);
    if (found === -1) return null;

    // Gaps cost; adjacency is free. A match at index 0 costs nothing at all.
    score += found === previous + 1 ? 0 : found - position + 1;
    previous = found;
    position = found + 1;
  }

  // Prefer shorter names among equally good matches, so "general" beats "general-chat".
  return score + text.length * 0.01;
}

const ICONS = { text: Hash, voice: Volume2, server: MessagesSquare } as const;

export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const servers = useAppStore((s) => s.servers);
  const channels = useAppStore((s) => s.channels);
  const dmChannels = useAppStore((s) => s.dmChannels);

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];

    for (const channel of Object.values(channels)) {
      if (channel.type !== 'text' && channel.type !== 'voice') continue;
      out.push({
        id: channel.id,
        kind: channel.type,
        label: channel.name,
        context: servers[channel.serverId]?.name ?? null,
        path: `/channels/${channel.serverId}/${channel.id}`,
      });
    }

    for (const dm of Object.values(dmChannels)) {
      const other = dm.recipients[0];
      if (!other) continue;
      out.push({
        id: dm.id,
        kind: 'dm',
        label: other.displayName || other.username,
        context: `${other.username}#${other.discriminator}`,
        path: `/dm/${dm.id}`,
        userId: other.id,
        avatarUrl: other.avatarUrl,
      });
    }

    for (const server of Object.values(servers)) {
      out.push({
        id: server.id,
        kind: 'server',
        label: server.name,
        context: null,
        path: `/channels/${server.id}`,
      });
    }

    return out;
  }, [channels, dmChannels, servers]);

  const results = useMemo(() => {
    const scored: { entry: Entry; score: number }[] = [];
    for (const entry of entries) {
      // Match the context too, so "hq gen" style narrowing works.
      const score = fuzzyScore(entry.label, query) ?? fuzzyScore(entry.context ?? '', query);
      if (score !== null) scored.push({ entry, score });
    }
    scored.sort((a, b) => a.score - b.score);
    // A long list is a scroll, not a menu; the point of this is the first result.
    return scored.slice(0, 12).map((s) => s.entry);
  }, [entries, query]);

  // Typing changes the list under the cursor, so the highlight goes back to the top.
  useEffect(() => setActive(0), [query]);

  // Keep the highlighted row visible when arrowing past the fold.
  useEffect(() => {
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (entry: Entry | undefined) => {
    if (!entry) return;
    navigate(entry.path);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="w-full max-w-[520px] overflow-hidden rounded-panel border border-line bg-surface-4 shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Quick switcher"
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setActive((index) => Math.min(index + 1, results.length - 1));
            } else if (event.key === 'ArrowUp') {
              event.preventDefault();
              setActive((index) => Math.max(index - 1, 0));
            } else if (event.key === 'Enter') {
              event.preventDefault();
              choose(results[active]);
            } else if (event.key === 'Escape') {
              onClose();
            }
          }}
          placeholder="Jump to a channel, conversation, or server…"
          aria-label="Search channels, conversations, and servers"
          className="w-full border-b border-line bg-transparent px-4 py-3.5 text-[15px] text-ink outline-none placeholder:text-ink-faint"
        />

        <div ref={listRef} className="scrollbar-slim max-h-[46vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-ink-faint">
              {query ? 'Nothing matches that.' : 'Nothing to jump to yet.'}
            </p>
          ) : (
            results.map((entry, index) => {
              const Icon = entry.kind === 'dm' ? null : ICONS[entry.kind];
              return (
                <button
                  key={`${entry.kind}:${entry.id}`}
                  type="button"
                  // Mouse and keyboard share one highlight rather than fighting over two.
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(entry)}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left',
                    index === active ? 'bg-surface-3 text-ink' : 'text-ink-dim',
                  )}
                >
                  {Icon ? (
                    <Icon size={16} className="shrink-0 text-ink-faint" aria-hidden />
                  ) : (
                    <Avatar
                      userId={entry.userId!}
                      name={entry.label}
                      src={entry.avatarUrl ?? null}
                      size={20}
                    />
                  )}
                  <span className="truncate text-[14px]">{entry.label}</span>
                  {entry.context && (
                    <span className="ml-auto shrink-0 truncate pl-3 text-[12px] text-ink-faint">
                      {entry.context}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11.5px] text-ink-faint">
          <span>
            <kbd className="rounded bg-surface-3 px-1">↑</kbd>{' '}
            <kbd className="rounded bg-surface-3 px-1">↓</kbd> to move
          </span>
          <span>
            <kbd className="rounded bg-surface-3 px-1">↵</kbd> to jump
          </span>
          <span>
            <kbd className="rounded bg-surface-3 px-1">esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
