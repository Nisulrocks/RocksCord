/**
 * Emoji picker.
 *
 * Anchored above its trigger, searchable, and keyboard-dismissable. The grid renders the
 * whole (curated) set without virtualisation because it is only a few hundred elements —
 * a virtual list here would be more code and more jank, not less.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import clsx from 'clsx';
import { emojiToken } from '@rockscord/shared';
import type { Emoji } from '@rockscord/shared';
import { useAppStore } from '../../store/useAppStore';
import { EMOJI_CATEGORIES, searchEmoji } from './emoji';

export function EmojiPicker({
  onSelect,
  onClose,
  serverId,
}: {
  onSelect: (emoji: string) => void;
  onClose: () => void;
  /** Custom emoji are per-server, so DMs simply have none. */
  serverId?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [activeCategory, setActiveCategory] = useState(EMOJI_CATEGORIES[0]!.name);

  const allEmojis = useAppStore((s) => s.emojis);
  const custom = useMemo(
    () =>
      serverId
        ? Object.values(allEmojis)
            .filter((emoji) => emoji.serverId === serverId)
            .sort((a, b) => a.name.localeCompare(b.name))
        : [],
    [allEmojis, serverId],
  );

  // Matched on name, so typing "cat" surfaces :party_cat: alongside the unicode ones.
  const customMatches = useMemo(
    () =>
      query.trim()
        ? custom.filter((emoji) => emoji.name.includes(query.trim().toLowerCase()))
        : custom,
    [custom, query],
  );

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    // Deferred by a frame so the click that *opened* the picker does not close it.
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointerDown);
    }, 0);
    document.addEventListener('keydown', onKeyDown);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onClose]);

  const searching = query.trim().length > 0;
  const results = useMemo(() => (searching ? searchEmoji(query) : []), [query, searching]);

  return (
    <div
      ref={ref}
      className="animate-pop-in absolute bottom-full right-0 z-30 mb-2 flex h-[340px] w-[340px] flex-col overflow-hidden rounded-lg border border-line-strong bg-surface-4 shadow-pop"
    >
      <div className="border-b border-line p-2">
        <div className="relative">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-faint"
          />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search emoji"
            className="w-full rounded-md border border-line bg-surface-0 py-1.5 pl-8 pr-2 text-[13px] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
          />
        </div>
      </div>

      <div className="scrollbar-slim flex-1 overflow-y-auto p-2">
        {searching ? (
          results.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-ink-faint">
              No emoji match “{query}”
            </p>
          ) : (
            <>
              {customMatches.length > 0 && (
                <div className="mb-3">
                  <h4 className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                    This server
                  </h4>
                  <CustomGrid emojis={customMatches} onSelect={onSelect} />
                </div>
              )}
              <Grid emoji={results} onSelect={onSelect} />
            </>
          )
        ) : (
          <>
            {custom.length > 0 && (
              <section id="emoji-custom" className="mb-3">
                <h4 className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                  This server
                </h4>
                <CustomGrid emojis={custom} onSelect={onSelect} />
              </section>
            )}
            {EMOJI_CATEGORIES.map((category) => (
            <section key={category.name} id={`emoji-${category.name}`} className="mb-3">
              <h4 className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
                {category.name}
              </h4>
              <Grid emoji={category.emoji} onSelect={onSelect} />
            </section>
            ))}
          </>
        )}
      </div>

      {!searching && (
        <div className="flex items-center gap-0.5 overflow-x-auto border-t border-line px-1.5 py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {EMOJI_CATEGORIES.map((category) => (
            <button
              key={category.name}
              title={category.name}
              onClick={() => {
                setActiveCategory(category.name);
                document
                  .getElementById(`emoji-${category.name}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              className={clsx(
                'shrink-0 rounded px-1.5 py-1 text-lg transition-colors',
                activeCategory === category.name ? 'bg-surface-3' : 'opacity-60 hover:opacity-100',
              )}
            >
              {category.emoji[0]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Custom emoji insert `<:name:id>` rather than a character.
 *
 * That is the same string contract the unicode grid uses -- the composer only ever splices
 * text into the draft -- so nothing above here needs to know the difference.
 */
function CustomGrid({
  emojis,
  onSelect,
}: {
  emojis: Emoji[];
  onSelect: (emoji: string) => void;
}) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {emojis.map((emoji) => (
        <button
          key={emoji.id}
          title={`:${emoji.name}:`}
          onClick={() => onSelect(emojiToken(emoji.name, emoji.id))}
          className="flex h-9 items-center justify-center rounded transition-transform hover:scale-125 hover:bg-surface-3"
        >
          <img src={emoji.imageUrl} alt={`:${emoji.name}:`} className="h-6 w-6 object-contain" />
        </button>
      ))}
    </div>
  );
}

function Grid({ emoji, onSelect }: { emoji: string[]; onSelect: (emoji: string) => void }) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {emoji.map((value, index) => (
        <button
          key={`${value}-${index}`}
          onClick={() => onSelect(value)}
          className="flex h-9 items-center justify-center rounded text-xl transition-transform hover:scale-125 hover:bg-surface-3"
        >
          {value}
        </button>
      ))}
    </div>
  );
}
