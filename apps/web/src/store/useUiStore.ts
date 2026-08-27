/**
 * Transient UI state: modals, context menus, toasts, and per-channel composer drafts.
 *
 * None of this is server state, so it deliberately does not live in the app store. The
 * one piece that persists is drafts, which survive channel switches because losing a
 * half-typed message when you glance at another channel is genuinely infuriating.
 */

import { create } from 'zustand';

export type ModalKind =
  | { kind: 'create-server' }
  | { kind: 'join-server' }
  | { kind: 'server-settings'; serverId: string; tab?: 'overview' | 'roles' | 'members' | 'invites' | 'audit' }
  | { kind: 'create-channel'; serverId: string; type?: 'text' | 'voice' }
  | { kind: 'channel-settings'; channelId: string }
  | { kind: 'user-settings'; tab?: 'profile' | 'account' | 'appearance' | 'voice' }
  | { kind: 'invite'; serverId: string }
  | { kind: 'add-friend' }
  | { kind: 'search'; serverId?: string; channelId?: string }
  | { kind: 'image'; url: string; fileName: string }
  | { kind: 'confirm'; title: string; body: string; confirmLabel?: string; danger?: boolean; onConfirm: () => void | Promise<void> };

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  /** Renders a divider above this item. */
  separated?: boolean;
  icon?: string;
}

export interface Toast {
  id: string;
  message: string;
  tone: 'info' | 'success' | 'error';
}

export interface ProfileCardState {
  userId: string;
  /** Anchor rectangle in viewport coordinates. */
  anchor: { x: number; y: number };
}

interface UiState {
  modal: ModalKind | null;
  contextMenu: ContextMenuState | null;
  profileCard: ProfileCardState | null;
  toasts: Toast[];

  /** channelId -> unsent composer text. */
  drafts: Record<string, string>;
  /** channelId -> message being replied to. */
  replyTargets: Record<string, { id: string; author: string } | null>;
  /** messageId currently being edited inline. */
  editingMessageId: string | null;

  /** Mobile layout: which pane is showing. */
  mobilePane: 'sidebar' | 'chat' | 'members';
  memberListOpen: boolean;

  openModal: (modal: ModalKind) => void;
  closeModal: () => void;
  openContextMenu: (menu: ContextMenuState) => void;
  closeContextMenu: () => void;
  openProfileCard: (card: ProfileCardState) => void;
  closeProfileCard: () => void;

  toast: (message: string, tone?: Toast['tone']) => void;
  dismissToast: (id: string) => void;

  setDraft: (channelId: string, value: string) => void;
  clearDraft: (channelId: string) => void;
  setReplyTarget: (channelId: string, target: { id: string; author: string } | null) => void;
  setEditingMessage: (messageId: string | null) => void;

  setMobilePane: (pane: 'sidebar' | 'chat' | 'members') => void;
  toggleMemberList: () => void;
}

const TOAST_TTL_MS = 4200;

export const useUiStore = create<UiState>((set, get) => ({
  modal: null,
  contextMenu: null,
  profileCard: null,
  toasts: [],
  drafts: {},
  replyTargets: {},
  editingMessageId: null,
  mobilePane: 'chat',
  memberListOpen: true,

  openModal: (modal) => set({ modal, contextMenu: null, profileCard: null }),
  closeModal: () => set({ modal: null }),

  openContextMenu: (contextMenu) => set({ contextMenu, profileCard: null }),
  closeContextMenu: () => set({ contextMenu: null }),

  openProfileCard: (profileCard) => set({ profileCard, contextMenu: null }),
  closeProfileCard: () => set({ profileCard: null }),

  toast: (message, tone = 'info') => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((state) => ({ toasts: [...state.toasts, { id, message, tone }] }));
    setTimeout(() => get().dismissToast(id), TOAST_TTL_MS);
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  setDraft: (channelId, value) =>
    set((state) => ({ drafts: { ...state.drafts, [channelId]: value } })),

  clearDraft: (channelId) =>
    set((state) => {
      const drafts = { ...state.drafts };
      delete drafts[channelId];
      return { drafts };
    }),

  setReplyTarget: (channelId, target) =>
    set((state) => ({ replyTargets: { ...state.replyTargets, [channelId]: target } })),

  setEditingMessage: (editingMessageId) => set({ editingMessageId }),

  setMobilePane: (mobilePane) => set({ mobilePane }),
  toggleMemberList: () => set((state) => ({ memberListOpen: !state.memberListOpen })),
}));
