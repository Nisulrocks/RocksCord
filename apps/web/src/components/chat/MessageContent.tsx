/**
 * Message renderer.
 *
 * **This component is the reason the app is not vulnerable to XSS in messages.** It never
 * touches `innerHTML` or `dangerouslySetInnerHTML`. Content is parsed into a token array
 * and each token becomes a React element, so any HTML a user types is rendered as literal
 * text by React's own escaping — not because a sanitiser stripped it, but because it is
 * never treated as markup in the first place.
 *
 * Supported inline formatting, in the order it is applied:
 *   ```code block```   `inline code`   **bold**   *italic*   __underline__
 *   ~~strike~~   ||spoiler||   https://links   @mentions   #channels
 */

import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { tokenizeMentions, type MessageToken } from '@rockscord/shared';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';

/** Emoji-only messages render large. Matches 1-8 emoji and nothing else. */
// Emoji, plus the invisible joiners that compose them (U+FE0F variation selector and
// U+200D zero-width joiner), and whitespace. Written as escapes rather than literal
// characters because invisible characters in source are impossible to review.
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F|\u200D|\s){1,24}$/u;

function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 24) return false;
  if (!/\p{Extended_Pictographic}/u.test(trimmed)) return false;
  return EMOJI_ONLY.test(trimmed);
}

export function MessageContent({
  content,
  serverId,
}: {
  content: string;
  serverId?: string | null;
}) {
  const jumbo = useMemo(() => isEmojiOnly(content), [content]);
  const blocks = useMemo(() => splitCodeBlocks(content), [content]);

  return (
    <div className={clsx('message-body text-[15px] leading-[1.45] text-ink', jumbo && 'jumbo-emoji')}>
      {blocks.map((block, index) =>
        block.type === 'code' ? (
          <pre key={index}>
            <code>{block.value}</code>
          </pre>
        ) : (
          <Fragment key={index}>
            <InlineText text={block.value} serverId={serverId} />
          </Fragment>
        ),
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Block parsing                                                               */
/* -------------------------------------------------------------------------- */

type Block = { type: 'text' | 'code'; value: string };

/** Split ```fenced``` code blocks out first so their contents are never re-parsed. */
function splitCodeBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  const pattern = /```(?:[a-zA-Z0-9+#-]*\n)?([\s\S]*?)```/g;
  let lastIndex = 0;

  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      blocks.push({ type: 'text', value: content.slice(lastIndex, index) });
    }
    blocks.push({ type: 'code', value: match[1] ?? '' });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < content.length) {
    blocks.push({ type: 'text', value: content.slice(lastIndex) });
  }
  return blocks.length > 0 ? blocks : [{ type: 'text', value: content }];
}

/* -------------------------------------------------------------------------- */
/* Inline parsing                                                              */
/* -------------------------------------------------------------------------- */

type Inline =
  | { type: 'text'; value: string }
  | { type: 'code'; value: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'spoiler'; value: string }
  | { type: 'link'; value: string };

/**
 * A single pass over the text with one alternating regex.
 *
 * Doing it in one pass (rather than nested replaces) is what keeps `**not *nested* **`
 * from producing overlapping matches, and keeps `` `**literal**` `` inside inline code
 * unformatted.
 */
const INLINE_PATTERN = new RegExp(
  [
    '(?<code>`[^`\\n]+`)',
    '(?<bold>\\*\\*[^*\\n]+\\*\\*)',
    '(?<underline>__[^_\\n]+__)',
    '(?<italic>\\*[^*\\n]+\\*)',
    '(?<strike>~~[^~\\n]+~~)',
    '(?<spoiler>\\|\\|[^\\n]+?\\|\\|)',
    '(?<link>https?://[^\\s<>"]+)',
  ].join('|'),
  'g',
);

function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) out.push({ type: 'text', value: text.slice(lastIndex, index) });

    const g = match.groups ?? {};
    if (g.code) out.push({ type: 'code', value: g.code.slice(1, -1) });
    else if (g.bold) out.push({ type: 'bold', value: g.bold.slice(2, -2) });
    else if (g.underline) out.push({ type: 'underline', value: g.underline.slice(2, -2) });
    else if (g.italic) out.push({ type: 'italic', value: g.italic.slice(1, -1) });
    else if (g.strike) out.push({ type: 'strike', value: g.strike.slice(2, -2) });
    else if (g.spoiler) out.push({ type: 'spoiler', value: g.spoiler.slice(2, -2) });
    else if (g.link) out.push({ type: 'link', value: g.link });

    lastIndex = index + match[0].length;
  }

  if (lastIndex < text.length) out.push({ type: 'text', value: text.slice(lastIndex) });
  return out;
}

function InlineText({ text, serverId }: { text: string; serverId?: string | null }) {
  const parts = useMemo(() => parseInline(text), [text]);

  return (
    <>
      {parts.map((part, index) => {
        switch (part.type) {
          case 'code':
            return <code key={index}>{part.value}</code>;
          case 'bold':
            return (
              <strong key={index} className="font-semibold">
                <MentionText text={part.value} serverId={serverId} />
              </strong>
            );
          case 'italic':
            return (
              <em key={index}>
                <MentionText text={part.value} serverId={serverId} />
              </em>
            );
          case 'underline':
            return (
              <u key={index}>
                <MentionText text={part.value} serverId={serverId} />
              </u>
            );
          case 'strike':
            return (
              <s key={index} className="text-ink-dim">
                <MentionText text={part.value} serverId={serverId} />
              </s>
            );
          case 'spoiler':
            return <Spoiler key={index} text={part.value} serverId={serverId} />;
          case 'link':
            return (
              <a
                key={index}
                href={part.value}
                target="_blank"
                // noreferrer also implies noopener; both are required so the opened page
                // cannot reach back through window.opener.
                rel="noreferrer noopener"
                className="text-accent-soft hover:underline"
              >
                {part.value}
              </a>
            );
          default:
            return <MentionText key={index} text={part.value} serverId={serverId} />;
        }
      })}
    </>
  );
}

function Spoiler({ text, serverId }: { text: string; serverId?: string | null }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      onClick={() => setRevealed(true)}
      className={clsx(
        'rounded px-1 transition-colors',
        revealed
          ? 'bg-surface-4 text-ink'
          : 'bg-surface-4 text-transparent select-none hover:bg-line-strong',
      )}
      title={revealed ? undefined : 'Spoiler — click to reveal'}
    >
      <MentionText text={text} serverId={serverId} />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Mentions                                                                    */
/* -------------------------------------------------------------------------- */

/** Turn `<@id>` / `<@&id>` / `<#id>` tokens into live, clickable chips. */
function MentionText({ text, serverId }: { text: string; serverId?: string | null }) {
  const tokens = useMemo<MessageToken[]>(() => tokenizeMentions(text), [text]);

  const userById = useAppStore((s) => s.userById);
  const roles = useAppStore((s) => s.roles);
  const channels = useAppStore((s) => s.channels);
  const emojis = useAppStore((s) => s.emojis);
  const openProfileCard = useUiStore((s) => s.openProfileCard);

  return (
    <>
      {tokens.map((token, index) => {
        if (token.type === 'text') return <Fragment key={index}>{token.value}</Fragment>;

        if (token.type === 'user') {
          const user = userById(token.id);
          return (
            <button
              key={index}
              onClick={(event) =>
                openProfileCard({
                  userId: token.id,
                  anchor: { x: event.clientX, y: event.clientY },
                })
              }
              className="rounded bg-accent-wash px-1 font-medium text-accent-soft transition-colors hover:bg-accent hover:text-white"
            >
              @{user?.displayName ?? 'unknown'}
            </button>
          );
        }

        if (token.type === 'role') {
          const role = roles[token.id];
          if (!role) return <Fragment key={index}>@unknown-role</Fragment>;
          return (
            <span
              key={index}
              className="rounded px-1 font-medium"
              style={{
                color: role.color,
                // 20 = ~12% alpha, enough to tint without hurting contrast.
                backgroundColor: `${role.color}20`,
              }}
            >
              @{role.name}
            </span>
          );
        }

        if (token.type === 'channel') {
          const channel = channels[token.id];
          if (!channel) return <Fragment key={index}>#unknown</Fragment>;
          return (
            <Link
              key={index}
              to={`/channels/${channel.serverId || serverId}/${channel.id}`}
              className="rounded bg-accent-wash px-1 font-medium text-accent-soft transition-colors hover:bg-accent hover:text-white"
            >
              #{channel.name}
            </Link>
          );
        }

        if (token.type === 'emoji') {
          const emoji = emojis[token.id];
          /*
           * Fall back to `:name:` when the emoji is unknown -- a message from a server
           * you have since left, or one deleted after it was used. The name travels in
           * the token precisely so this reads as something rather than vanishing.
           *
           * `src` comes from the server's own storage URL and the alt text is the
           * validated name, so neither is attacker-controlled markup: this is still an
           * element built from data, never parsed HTML.
           */
          if (!emoji) return <Fragment key={index}>:{token.name}:</Fragment>;
          return (
            <img
              key={index}
              src={emoji.imageUrl}
              alt={`:${emoji.name}:`}
              title={`:${emoji.name}:`}
              loading="lazy"
              // Inline and baseline-aligned so a line of text with emoji in it keeps its
              // rhythm instead of growing taller than its neighbours.
              className="inline-block h-[1.375em] w-[1.375em] object-contain align-[-0.3em]"
            />
          );
        }

        return (
          <span key={index} className="rounded bg-accent-wash px-1 font-medium text-accent-soft">
            {token.value}
          </span>
        );
      })}
    </>
  );
}
