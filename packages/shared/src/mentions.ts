/**
 * Mention encoding.
 *
 * Messages store mentions as stable id tokens rather than raw text, so renaming a user or
 * channel does not break every message that mentioned it:
 *
 *   <@USER_ID>     -> user mention
 *   <@&ROLE_ID>    -> role mention
 *   <#CHANNEL_ID>  -> channel mention
 *   @everyone / @here -> special, permission-gated
 *
 * The composer turns an autocompleted `@name` into a token before sending; the renderer
 * turns it back into a name at display time.
 */

export const MENTION_PATTERN = /<@!?(?<user>[A-Za-z0-9_-]{1,64})>|<@&(?<role>[A-Za-z0-9_-]{1,64})>|<#(?<channel>[A-Za-z0-9_-]{1,64})>/g;

/**
 * A custom emoji reference: `<:name:id>`.
 *
 * The name travels with the id so a client that has never loaded that server's emoji
 * still shows something -- it falls back to `:name:` rather than an empty gap. Both
 * halves use a closed alphabet, so nothing inside a token can terminate it early.
 */
export const EMOJI_PATTERN = /<:(?<emojiName>[a-z0-9_]{2,32}):(?<emojiId>[A-Za-z0-9_-]{1,64})>/g;

export interface ParsedMentions {
  userIds: string[];
  roleIds: string[];
  channelIds: string[];
  everyone: boolean;
}

/** Extract every mention from raw message content. Used server-side to fan out pings. */
export function parseMentions(content: string): ParsedMentions {
  const userIds = new Set<string>();
  const roleIds = new Set<string>();
  const channelIds = new Set<string>();

  for (const match of content.matchAll(MENTION_PATTERN)) {
    const groups = match.groups;
    if (!groups) continue;
    if (groups.user) userIds.add(groups.user);
    else if (groups.role) roleIds.add(groups.role);
    else if (groups.channel) channelIds.add(groups.channel);
  }

  // Require a word boundary so "email@everyone.com" does not ping the server.
  const everyone = /(^|\s)@(everyone|here)\b/.test(content);

  return {
    userIds: [...userIds],
    roleIds: [...roleIds],
    channelIds: [...channelIds],
    everyone,
  };
}

export type MessageToken =
  | { type: 'text'; value: string }
  | { type: 'user'; id: string }
  | { type: 'role'; id: string }
  | { type: 'channel'; id: string }
  | { type: 'everyone'; value: string }
  | { type: 'emoji'; id: string; name: string };

/**
 * Split content into renderable tokens. The client walks this instead of using
 * `dangerouslySetInnerHTML`, which is what keeps message rendering XSS-free by
 * construction rather than by sanitising after the fact.
 */
export function tokenizeMentions(content: string): MessageToken[] {
  const tokens: MessageToken[] = [];
  let lastIndex = 0;

  const pattern = new RegExp(
    `${MENTION_PATTERN.source}|${EMOJI_PATTERN.source}|(?<everyone>(?<=^|\s)@(?:everyone|here)\b)`,
    'g',
  );

  for (const match of content.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      tokens.push({ type: 'text', value: content.slice(lastIndex, index) });
    }
    const g = match.groups ?? {};
    if (g.user) tokens.push({ type: 'user', id: g.user });
    else if (g.role) tokens.push({ type: 'role', id: g.role });
    else if (g.channel) tokens.push({ type: 'channel', id: g.channel });
    else if (g.emojiId && g.emojiName)
      tokens.push({ type: 'emoji', id: g.emojiId, name: g.emojiName });
    else if (g.everyone) tokens.push({ type: 'everyone', value: g.everyone });
    lastIndex = index + match[0].length;
  }

  if (lastIndex < content.length) {
    tokens.push({ type: 'text', value: content.slice(lastIndex) });
  }
  return tokens;
}

/** Build the token a composer should insert for a user mention. */
export const userMention = (id: string) => `<@${id}>`;
export const roleMention = (id: string) => `<@&${id}>`;
export const channelMention = (id: string) => `<#${id}>`;
/** The token a composer inserts for a custom emoji. */
export const emojiToken = (name: string, id: string) => `<:${name}:${id}>`;
