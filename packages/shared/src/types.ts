/**
 * Wire types shared between the API, the realtime gateway, and the clients.
 * These describe what the server *sends*; request bodies live in `validation.ts`.
 */

export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';
export type ChannelType = 'text' | 'voice';
export type FriendshipStatus = 'pending' | 'accepted' | 'blocked';

/** The safe, public projection of a user. Never contains email or password data. */
export interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  discriminator: string;
  avatarUrl: string | null;
  bio: string | null;
  status: UserStatus;
  /** Custom status text, e.g. "debugging WebRTC". */
  customStatus: string | null;
  createdAt: number;
}

/** Everything a user is allowed to know about themselves. */
export interface SelfUser extends PublicUser {
  email: string;
}

export interface Server {
  id: string;
  name: string;
  iconUrl: string | null;
  description: string | null;
  ownerId: string;
  createdAt: number;
  memberCount?: number;
}

export interface Role {
  id: string;
  serverId: string;
  name: string;
  color: string;
  permissions: number;
  /** Higher position = higher in the hierarchy. @everyone is always 0. */
  position: number;
  /** Show members with this role in their own group in the member list. */
  hoist: boolean;
  mentionable: boolean;
  /** True for the implicit @everyone role, which cannot be deleted. */
  isDefault: boolean;
}

export interface Member {
  userId: string;
  serverId: string;
  nickname: string | null;
  roleIds: string[];
  joinedAt: number;
  user: PublicUser;
}

export interface Channel {
  id: string;
  serverId: string;
  name: string;
  type: ChannelType;
  topic: string | null;
  position: number;
  createdAt: number;
  /** Only present when the requester has explicitly asked for overwrites. */
  overwrites?: ChannelOverwrite[];
}

export interface ChannelOverwrite {
  channelId: string;
  targetType: 'role' | 'member';
  targetId: string;
  allow: number;
  deny: number;
}

export interface Attachment {
  id: string;
  fileName: string;
  /** Bytes. */
  size: number;
  contentType: string;
  url: string;
  /** Populated for images so the client can reserve layout space before loading. */
  width: number | null;
  height: number | null;
}

export interface Reaction {
  emoji: string;
  count: number;
  /** Whether the requesting user is among the reactors. */
  me: boolean;
}

export interface Message {
  id: string;
  channelId: string;
  authorId: string;
  author: PublicUser;
  content: string;
  createdAt: number;
  editedAt: number | null;
  /** Set when this message is a reply; null otherwise. */
  replyToId: string | null;
  /** A trimmed copy of the replied-to message for rendering the reply preview. */
  replyTo: MessagePreview | null;
  attachments: Attachment[];
  reactions: Reaction[];
  mentionUserIds: string[];
  mentionsEveryone: boolean;
  pinned: boolean;
  /** Deleted messages are tombstoned so replies pointing at them still render. */
  deleted: boolean;
}

export interface MessagePreview {
  id: string;
  authorId: string;
  author: PublicUser | null;
  content: string;
  deleted: boolean;
}

/** A private conversation. Currently 1:1; the schema allows group DMs later. */
export interface DMChannel {
  id: string;
  type: 'dm';
  recipients: PublicUser[];
  lastMessageAt: number | null;
  createdAt: number;
}

export interface Friendship {
  id: string;
  status: FriendshipStatus;
  /** Who sent the request. Determines whether the UI shows accept/reject or cancel. */
  requesterId: string;
  user: PublicUser;
  createdAt: number;
}

export interface Invite {
  code: string;
  serverId: string;
  inviterId: string;
  uses: number;
  maxUses: number | null;
  expiresAt: number | null;
  createdAt: number;
  server?: Pick<Server, 'id' | 'name' | 'iconUrl' | 'description'> & { memberCount: number };
}

/** Per-channel read state, used to compute unread dots and mention badges. */
export interface ReadState {
  channelId: string;
  lastReadMessageId: string | null;
  mentionCount: number;
  /** Server-computed convenience flag. */
  unread: boolean;
}

export interface VoiceParticipant {
  userId: string;
  channelId: string;
  user: PublicUser;
  selfMute: boolean;
  selfDeaf: boolean;
  /** Set by a moderator, not by the user. */
  serverMute: boolean;
  serverDeaf: boolean;
  streaming: boolean;
  joinedAt: number;
}

/** The payload delivered on connect so the client can render without extra round-trips. */
export interface ReadyPayload {
  user: SelfUser;
  servers: Server[];
  channels: Channel[];
  roles: Role[];
  /** Only the requesting user's memberships, one per server. */
  memberships: { serverId: string; roleIds: string[]; nickname: string | null }[];
  dmChannels: DMChannel[];
  friends: Friendship[];
  readStates: ReadState[];
  voiceStates: VoiceParticipant[];
  /** Presence of everyone visible to this user (friends + co-members). */
  presences: { userId: string; status: UserStatus; customStatus: string | null }[];
}

export interface PaginatedMessages {
  messages: Message[];
  /** Cursor to pass as `before` to fetch the next older page. */
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    /** Field-level detail for validation failures. */
    details?: Record<string, string[]>;
  };
}
