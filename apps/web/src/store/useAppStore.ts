/**
 * Application state.
 *
 * One store, because almost every realtime event touches more than one slice: a new
 * message updates the message list, the channel's unread state, the DM ordering, and the
 * notification tray. Splitting those into separate stores would mean coordinating writes
 * across them for every event.
 *
 * The store is written to from two directions:
 *   - REST responses (user actions)
 *   - socket events (everyone else's actions)
 * Both funnel through the same reducers below, so an action feels identical whether it
 * originated locally or arrived from the server.
 */

import { create } from 'zustand';
import type {
  Channel,
  DMChannel,
  Friendship,
  Member,
  Message,
  PublicUser,
  ReadState,
  ReadyPayload,
  Role,
  SelfUser,
  Server,
  UserStatus,
  VoiceParticipant,
} from '@rockscord/shared';
import type { NotificationPayload } from '@rockscord/shared';

export interface TypingEntry {
  userId: string;
  username: string;
  /** Timestamp of the last typing event; used to expire the indicator. */
  at: number;
}

export interface ChannelPaging {
  /** True while a page request is in flight. */
  loading: boolean;
  /** False until the first page has been fetched. */
  loaded: boolean;
  /** More history exists above the oldest loaded message. */
  hasMore: boolean;
}

interface AppState {
  /* Session ------------------------------------------------------------- */
  user: SelfUser | null;
  connected: boolean;
  /** True once the socket has delivered its `ready` payload. */
  hydrated: boolean;

  /* Entities ------------------------------------------------------------ */
  servers: Record<string, Server>;
  channels: Record<string, Channel>;
  roles: Record<string, Role>;
  memberships: Record<string, { roleIds: string[]; nickname: string | null }>;
  membersByServer: Record<string, Record<string, Member>>;
  dmChannels: Record<string, DMChannel>;

  /** Oldest-first, so appending a new message is a push. */
  messagesByChannel: Record<string, Message[]>;
  paging: Record<string, ChannelPaging>;

  friends: Friendship[];
  incomingRequests: Friendship[];
  outgoingRequests: Friendship[];

  readStates: Record<string, ReadState>;
  presence: Record<string, { status: UserStatus; customStatus: string | null }>;
  typing: Record<string, TypingEntry[]>;
  voiceParticipants: Record<string, VoiceParticipant[]>;
  notifications: NotificationPayload[];

  /* Navigation ---------------------------------------------------------- */
  activeServerId: string | null;
  activeChannelId: string | null;

  /* Actions ------------------------------------------------------------- */
  applyReady: (payload: ReadyPayload) => void;
  reset: () => void;
  setConnected: (connected: boolean) => void;
  setUser: (user: SelfUser | null) => void;

  setActive: (serverId: string | null, channelId: string | null) => void;

  upsertServer: (server: Server) => void;
  removeServer: (serverId: string) => void;
  upsertChannel: (channel: Channel) => void;
  removeChannel: (serverId: string, channelId: string) => void;
  upsertRole: (role: Role) => void;
  removeRole: (serverId: string, roleId: string) => void;

  setMembers: (serverId: string, members: Member[]) => void;
  upsertMember: (member: Member) => void;
  removeMember: (serverId: string, userId: string) => void;

  upsertDMChannel: (channel: DMChannel) => void;

  setMessages: (channelId: string, messages: Message[], hasMore: boolean) => void;
  prependMessages: (channelId: string, messages: Message[], hasMore: boolean) => void;
  addMessage: (message: Message) => void;
  updateMessage: (message: Message) => void;
  removeMessage: (channelId: string, messageId: string) => void;
  setPaging: (channelId: string, paging: Partial<ChannelPaging>) => void;
  applyReaction: (
    channelId: string,
    messageId: string,
    emoji: string,
    userId: string,
    added: boolean,
  ) => void;

  setFriends: (payload: {
    friends: Friendship[];
    incoming: Friendship[];
    outgoing: Friendship[];
  }) => void;
  upsertFriendship: (friendship: Friendship) => void;
  removeFriendOf: (userId: string) => void;

  setPresence: (userId: string, status: UserStatus, customStatus: string | null) => void;
  noteTyping: (channelId: string, userId: string, username: string) => void;
  pruneTyping: () => void;

  markRead: (channelId: string, messageId: string) => void;
  setReadStates: (states: ReadState[]) => void;

  setVoiceParticipants: (channelId: string, participants: VoiceParticipant[]) => void;
  upsertVoiceParticipant: (participant: VoiceParticipant) => void;
  removeVoiceParticipant: (channelId: string, userId: string) => void;

  pushNotification: (notification: NotificationPayload) => void;
  clearNotifications: () => void;

  /* Selectors (as plain functions to avoid recomputing in every component) */
  channelsForServer: (serverId: string) => Channel[];
  rolesForServer: (serverId: string) => Role[];
  serverUnread: (serverId: string) => { unread: boolean; mentions: number };
  userById: (userId: string) => PublicUser | null;
}

/**
 * Shared frozen empties.
 *
 * Zustand selectors run on every store update and their result is compared by reference.
 * A selector written as `s.messagesByChannel[id] ?? []` therefore returns a *new* array
 * every call, React's `useSyncExternalStore` sees the snapshot change on every render,
 * and the component loops until React throws "Maximum update depth exceeded".
 *
 * Returning one shared frozen instance keeps the reference stable for the empty case.
 */
export const EMPTY_ARRAY = Object.freeze([]) as unknown as never[];

const TYPING_TTL_MS = 8000;
/** Messages kept in memory per channel. Older ones are re-fetched on scroll. */
const MESSAGE_CACHE_LIMIT = 400;

const emptyState = {
  user: null,
  connected: false,
  hydrated: false,
  servers: {},
  channels: {},
  roles: {},
  memberships: {},
  membersByServer: {},
  dmChannels: {},
  messagesByChannel: {},
  paging: {},
  friends: [],
  incomingRequests: [],
  outgoingRequests: [],
  readStates: {},
  presence: {},
  typing: {},
  voiceParticipants: {},
  notifications: [],
  activeServerId: null,
  activeChannelId: null,
} satisfies Partial<AppState>;

export const useAppStore = create<AppState>((set, get) => ({
  ...emptyState,

  /* -------------------------------------------------------------------- */
  /* Bootstrap                                                             */
  /* -------------------------------------------------------------------- */

  applyReady: (payload) =>
    set(() => {
      const servers: Record<string, Server> = {};
      for (const server of payload.servers) servers[server.id] = server;

      const channels: Record<string, Channel> = {};
      for (const channel of payload.channels) channels[channel.id] = channel;

      const roles: Record<string, Role> = {};
      for (const role of payload.roles) roles[role.id] = role;

      const memberships: Record<string, { roleIds: string[]; nickname: string | null }> = {};
      for (const membership of payload.memberships) {
        memberships[membership.serverId] = {
          roleIds: membership.roleIds,
          nickname: membership.nickname,
        };
      }

      const dmChannels: Record<string, DMChannel> = {};
      for (const dm of payload.dmChannels) dmChannels[dm.id] = dm;

      const readStates: Record<string, ReadState> = {};
      for (const state of payload.readStates) readStates[state.channelId] = state;

      const presence: Record<string, { status: UserStatus; customStatus: string | null }> = {};
      for (const entry of payload.presences) {
        presence[entry.userId] = { status: entry.status, customStatus: entry.customStatus };
      }

      const voiceParticipants: Record<string, VoiceParticipant[]> = {};
      for (const participant of payload.voiceStates) {
        (voiceParticipants[participant.channelId] ??= []).push(participant);
      }

      return {
        user: payload.user,
        hydrated: true,
        servers,
        channels,
        roles,
        memberships,
        dmChannels,
        readStates,
        presence,
        voiceParticipants,
        friends: payload.friends.filter((f) => f.status === 'accepted'),
        incomingRequests: payload.friends.filter(
          (f) => f.status === 'pending' && f.requesterId !== payload.user.id,
        ),
        outgoingRequests: payload.friends.filter(
          (f) => f.status === 'pending' && f.requesterId === payload.user.id,
        ),
      };
    }),

  reset: () => set(() => ({ ...emptyState })),
  setConnected: (connected) => set({ connected }),
  setUser: (user) => set({ user }),
  setActive: (activeServerId, activeChannelId) => set({ activeServerId, activeChannelId }),

  /* -------------------------------------------------------------------- */
  /* Servers, channels, roles                                              */
  /* -------------------------------------------------------------------- */

  upsertServer: (server) =>
    set((state) => ({ servers: { ...state.servers, [server.id]: server } })),

  removeServer: (serverId) =>
    set((state) => {
      const servers = { ...state.servers };
      delete servers[serverId];

      // Drop the server's channels and their cached messages so a rejoin starts clean.
      const channels = { ...state.channels };
      const messagesByChannel = { ...state.messagesByChannel };
      for (const [id, channel] of Object.entries(state.channels)) {
        if (channel.serverId === serverId) {
          delete channels[id];
          delete messagesByChannel[id];
        }
      }

      const roles = { ...state.roles };
      for (const [id, role] of Object.entries(state.roles)) {
        if (role.serverId === serverId) delete roles[id];
      }

      const memberships = { ...state.memberships };
      delete memberships[serverId];

      const membersByServer = { ...state.membersByServer };
      delete membersByServer[serverId];

      return {
        servers,
        channels,
        roles,
        memberships,
        membersByServer,
        messagesByChannel,
        // If the deleted server was open, fall back to the home view.
        activeServerId: state.activeServerId === serverId ? null : state.activeServerId,
        activeChannelId:
          state.activeChannelId && !channels[state.activeChannelId]
            ? null
            : state.activeChannelId,
      };
    }),

  upsertChannel: (channel) =>
    set((state) => ({ channels: { ...state.channels, [channel.id]: channel } })),

  removeChannel: (_serverId, channelId) =>
    set((state) => {
      const channels = { ...state.channels };
      delete channels[channelId];
      const messagesByChannel = { ...state.messagesByChannel };
      delete messagesByChannel[channelId];
      return {
        channels,
        messagesByChannel,
        activeChannelId: state.activeChannelId === channelId ? null : state.activeChannelId,
      };
    }),

  upsertRole: (role) => set((state) => ({ roles: { ...state.roles, [role.id]: role } })),

  removeRole: (_serverId, roleId) =>
    set((state) => {
      const roles = { ...state.roles };
      delete roles[roleId];
      return { roles };
    }),

  /* -------------------------------------------------------------------- */
  /* Members                                                               */
  /* -------------------------------------------------------------------- */

  setMembers: (serverId, members) =>
    set((state) => {
      const byId: Record<string, Member> = {};
      for (const member of members) byId[member.userId] = member;
      return { membersByServer: { ...state.membersByServer, [serverId]: byId } };
    }),

  upsertMember: (member) =>
    set((state) => ({
      membersByServer: {
        ...state.membersByServer,
        [member.serverId]: {
          ...(state.membersByServer[member.serverId] ?? {}),
          [member.userId]: member,
        },
      },
    })),

  removeMember: (serverId, userId) =>
    set((state) => {
      const forServer = { ...(state.membersByServer[serverId] ?? {}) };
      delete forServer[userId];
      return { membersByServer: { ...state.membersByServer, [serverId]: forServer } };
    }),

  upsertDMChannel: (channel) =>
    set((state) => ({ dmChannels: { ...state.dmChannels, [channel.id]: channel } })),

  /* -------------------------------------------------------------------- */
  /* Messages                                                              */
  /* -------------------------------------------------------------------- */

  setMessages: (channelId, messages, hasMore) =>
    set((state) => ({
      messagesByChannel: { ...state.messagesByChannel, [channelId]: messages },
      paging: {
        ...state.paging,
        [channelId]: { loading: false, loaded: true, hasMore },
      },
    })),

  prependMessages: (channelId, messages, hasMore) =>
    set((state) => {
      const existing = state.messagesByChannel[channelId] ?? [];
      const known = new Set(existing.map((m) => m.id));
      const fresh = messages.filter((m) => !known.has(m.id));
      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: [...fresh, ...existing],
        },
        paging: {
          ...state.paging,
          [channelId]: { loading: false, loaded: true, hasMore },
        },
      };
    }),

  addMessage: (message) =>
    set((state) => {
      const existing = state.messagesByChannel[message.channelId] ?? [];

      // The same message can arrive twice: once through the channel room and once
      // through the recipient's personal room. Ids make de-duplication exact.
      if (existing.some((m) => m.id === message.id)) return {};

      // Ids sort chronologically, so a late-arriving message is placed rather than
      // appended blindly -- which keeps ordering correct under reconnection.
      const next = [...existing, message];
      if (existing.length > 0 && message.id < existing[existing.length - 1]!.id) {
        next.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      }

      const trimmed =
        next.length > MESSAGE_CACHE_LIMIT ? next.slice(next.length - MESSAGE_CACHE_LIMIT) : next;

      // A new message reorders the DM list and clears the sender's typing indicator.
      const dm = state.dmChannels[message.channelId];
      const dmChannels = dm
        ? {
            ...state.dmChannels,
            [message.channelId]: { ...dm, lastMessageAt: message.createdAt },
          }
        : state.dmChannels;

      const typingForChannel = (state.typing[message.channelId] ?? []).filter(
        (entry) => entry.userId !== message.authorId,
      );

      const isMine = message.authorId === state.user?.id;
      const isActive = state.activeChannelId === message.channelId;
      const existingRead = state.readStates[message.channelId];

      const readStates =
        isMine || isActive
          ? {
              ...state.readStates,
              [message.channelId]: {
                channelId: message.channelId,
                lastReadMessageId: message.id,
                mentionCount: 0,
                unread: false,
              },
            }
          : {
              ...state.readStates,
              [message.channelId]: {
                channelId: message.channelId,
                lastReadMessageId: existingRead?.lastReadMessageId ?? null,
                mentionCount:
                  (existingRead?.mentionCount ?? 0) +
                  (message.mentionUserIds.includes(state.user?.id ?? '') ||
                  message.mentionsEveryone
                    ? 1
                    : 0),
                unread: true,
              },
            };

      return {
        messagesByChannel: { ...state.messagesByChannel, [message.channelId]: trimmed },
        typing: { ...state.typing, [message.channelId]: typingForChannel },
        dmChannels,
        readStates,
      };
    }),

  updateMessage: (message) =>
    set((state) => {
      const existing = state.messagesByChannel[message.channelId];
      if (!existing) return {};
      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [message.channelId]: existing.map((m) => (m.id === message.id ? message : m)),
        },
      };
    }),

  removeMessage: (channelId, messageId) =>
    set((state) => {
      const existing = state.messagesByChannel[channelId];
      if (!existing) return {};
      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          // Tombstone rather than splice: replies pointing here still need to render.
          [channelId]: existing.map((m) =>
            m.id === messageId
              ? { ...m, deleted: true, content: '', attachments: [], reactions: [] }
              : m,
          ),
        },
      };
    }),

  setPaging: (channelId, paging) =>
    set((state) => ({
      paging: {
        ...state.paging,
        [channelId]: {
          loading: false,
          loaded: false,
          hasMore: true,
          ...state.paging[channelId],
          ...paging,
        },
      },
    })),

  applyReaction: (channelId, messageId, emoji, userId, added) =>
    set((state) => {
      const existing = state.messagesByChannel[channelId];
      if (!existing) return {};
      const myId = state.user?.id;

      return {
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: existing.map((message) => {
            if (message.id !== messageId) return message;

            const reactions = [...message.reactions];
            const index = reactions.findIndex((r) => r.emoji === emoji);

            if (added) {
              if (index === -1) {
                reactions.push({ emoji, count: 1, me: userId === myId });
              } else {
                const current = reactions[index]!;
                reactions[index] = {
                  ...current,
                  count: current.count + 1,
                  me: current.me || userId === myId,
                };
              }
            } else if (index !== -1) {
              const current = reactions[index]!;
              const count = current.count - 1;
              if (count <= 0) reactions.splice(index, 1);
              else {
                reactions[index] = {
                  ...current,
                  count,
                  me: userId === myId ? false : current.me,
                };
              }
            }

            return { ...message, reactions };
          }),
        },
      };
    }),

  /* -------------------------------------------------------------------- */
  /* Friends                                                               */
  /* -------------------------------------------------------------------- */

  setFriends: ({ friends, incoming, outgoing }) =>
    set({ friends, incomingRequests: incoming, outgoingRequests: outgoing }),

  upsertFriendship: (friendship) =>
    set((state) => {
      const myId = state.user?.id;
      const drop = (list: Friendship[]) => list.filter((f) => f.id !== friendship.id);

      if (friendship.status === 'accepted') {
        return {
          friends: [...drop(state.friends), friendship],
          incomingRequests: drop(state.incomingRequests),
          outgoingRequests: drop(state.outgoingRequests),
        };
      }
      if (friendship.status === 'pending') {
        const mine = friendship.requesterId === myId;
        return {
          friends: drop(state.friends),
          incomingRequests: mine
            ? drop(state.incomingRequests)
            : [...drop(state.incomingRequests), friendship],
          outgoingRequests: mine
            ? [...drop(state.outgoingRequests), friendship]
            : drop(state.outgoingRequests),
        };
      }
      return {
        friends: drop(state.friends),
        incomingRequests: drop(state.incomingRequests),
        outgoingRequests: drop(state.outgoingRequests),
      };
    }),

  removeFriendOf: (userId) =>
    set((state) => ({
      friends: state.friends.filter((f) => f.user.id !== userId),
      incomingRequests: state.incomingRequests.filter((f) => f.user.id !== userId),
      outgoingRequests: state.outgoingRequests.filter((f) => f.user.id !== userId),
    })),

  /* -------------------------------------------------------------------- */
  /* Presence & typing                                                     */
  /* -------------------------------------------------------------------- */

  setPresence: (userId, status, customStatus) =>
    set((state) => ({
      presence: { ...state.presence, [userId]: { status, customStatus } },
    })),

  noteTyping: (channelId, userId, username) =>
    set((state) => {
      const existing = (state.typing[channelId] ?? []).filter((e) => e.userId !== userId);
      return {
        typing: {
          ...state.typing,
          [channelId]: [...existing, { userId, username, at: Date.now() }],
        },
      };
    }),

  pruneTyping: () =>
    set((state) => {
      const cutoff = Date.now() - TYPING_TTL_MS;
      let changed = false;
      const typing: Record<string, TypingEntry[]> = {};

      for (const [channelId, entries] of Object.entries(state.typing)) {
        const live = entries.filter((entry) => entry.at > cutoff);
        if (live.length !== entries.length) changed = true;
        if (live.length > 0) typing[channelId] = live;
        else if (entries.length > 0) changed = true;
      }

      // Returning {} keeps the previous object identity and avoids a pointless re-render.
      return changed ? { typing } : {};
    }),

  /* -------------------------------------------------------------------- */
  /* Read state                                                            */
  /* -------------------------------------------------------------------- */

  markRead: (channelId, messageId) =>
    set((state) => ({
      readStates: {
        ...state.readStates,
        [channelId]: {
          channelId,
          lastReadMessageId: messageId,
          mentionCount: 0,
          unread: false,
        },
      },
    })),

  setReadStates: (states) =>
    set(() => {
      const readStates: Record<string, ReadState> = {};
      for (const state of states) readStates[state.channelId] = state;
      return { readStates };
    }),

  /* -------------------------------------------------------------------- */
  /* Voice                                                                 */
  /* -------------------------------------------------------------------- */

  setVoiceParticipants: (channelId, participants) =>
    set((state) => ({
      voiceParticipants: { ...state.voiceParticipants, [channelId]: participants },
    })),

  upsertVoiceParticipant: (participant) =>
    set((state) => {
      const existing = state.voiceParticipants[participant.channelId] ?? [];
      const next = [
        ...existing.filter((p) => p.userId !== participant.userId),
        participant,
      ].sort((a, b) => a.joinedAt - b.joinedAt);

      // A user can only be in one voice channel, so remove them from any other.
      const voiceParticipants = { ...state.voiceParticipants };
      for (const [channelId, list] of Object.entries(voiceParticipants)) {
        if (channelId === participant.channelId) continue;
        const filtered = list.filter((p) => p.userId !== participant.userId);
        if (filtered.length !== list.length) voiceParticipants[channelId] = filtered;
      }
      voiceParticipants[participant.channelId] = next;

      return { voiceParticipants };
    }),

  removeVoiceParticipant: (channelId, userId) =>
    set((state) => ({
      voiceParticipants: {
        ...state.voiceParticipants,
        [channelId]: (state.voiceParticipants[channelId] ?? []).filter(
          (p) => p.userId !== userId,
        ),
      },
    })),

  /* -------------------------------------------------------------------- */
  /* Notifications                                                         */
  /* -------------------------------------------------------------------- */

  pushNotification: (notification) =>
    set((state) => ({ notifications: [notification, ...state.notifications].slice(0, 50) })),

  clearNotifications: () => set({ notifications: [] }),

  /* -------------------------------------------------------------------- */
  /* Selectors                                                             */
  /* -------------------------------------------------------------------- */

  channelsForServer: (serverId) =>
    Object.values(get().channels)
      .filter((channel) => channel.serverId === serverId)
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1)),

  rolesForServer: (serverId) =>
    Object.values(get().roles)
      .filter((role) => role.serverId === serverId)
      .sort((a, b) => b.position - a.position),

  serverUnread: (serverId) => {
    const state = get();
    let unread = false;
    let mentions = 0;
    for (const channel of Object.values(state.channels)) {
      if (channel.serverId !== serverId) continue;
      const readState = state.readStates[channel.id];
      if (!readState) continue;
      if (readState.unread) unread = true;
      mentions += readState.mentionCount;
    }
    return { unread, mentions };
  },

  userById: (userId) => {
    const state = get();
    if (state.user?.id === userId) return state.user;

    for (const members of Object.values(state.membersByServer)) {
      const member = members[userId];
      if (member) return member.user;
    }
    for (const dm of Object.values(state.dmChannels)) {
      const recipient = dm.recipients.find((r) => r.id === userId);
      if (recipient) return recipient;
    }
    const friend = state.friends.find((f) => f.user.id === userId);
    return friend?.user ?? null;
  },
}));

/** Live presence for a user, falling back to their stored status. */
export function usePresence(userId: string | undefined): UserStatus {
  return useAppStore((state) => (userId ? (state.presence[userId]?.status ?? 'offline') : 'offline'));
}
