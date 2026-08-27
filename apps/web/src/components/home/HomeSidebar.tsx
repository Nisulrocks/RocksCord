/**
 * The home sidebar: friends entry point plus the direct-message list.
 *
 * DMs are ordered by last activity, so the conversation you are actually in is always at
 * the top. Unread conversations stay bold and keep their dot until opened.
 */

import { useNavigate, useLocation } from 'react-router-dom';
import { UserRound, X } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { Avatar } from '../ui/Avatar';
import { Badge, SectionLabel } from '../ui/primitives';

export function HomeSidebar() {
  const navigate = useNavigate();
  const location = useLocation();

  const dmChannels = useAppStore((s) => s.dmChannels);
  const readStates = useAppStore((s) => s.readStates);
  const presence = useAppStore((s) => s.presence);
  const incoming = useAppStore((s) => s.incomingRequests);
  const activeChannelId = useAppStore((s) => s.activeChannelId);

  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const setMobilePane = useUiStore((s) => s.setMobilePane);
  const openModal = useUiStore((s) => s.openModal);

  const onFriends = location.pathname.startsWith('/friends');

  const ordered = Object.values(dmChannels).sort(
    (a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt),
  );

  return (
    <div className="flex flex-col">
      <div className="flex h-12 shrink-0 items-center border-b border-line px-3">
        <button
          onClick={() => openModal({ kind: 'search' })}
          className="w-full rounded bg-surface-0 px-2 py-1.5 text-left text-[13px] text-ink-faint transition-colors hover:text-ink-dim"
        >
          Find or start a conversation
        </button>
      </div>

      <div className="px-2 py-3">
        <button
          onClick={() => {
            navigate('/friends');
            setMobilePane('chat');
          }}
          className={clsx(
            'mb-3 flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition-colors',
            onFriends ? 'bg-surface-4 text-ink' : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
          )}
        >
          <UserRound size={20} className="shrink-0" />
          <span className="flex-1 text-[15px] font-medium">Friends</span>
          <Badge count={incoming.length} />
        </button>

        <SectionLabel className="mb-1 mt-2">Direct messages</SectionLabel>

        {ordered.length === 0 && (
          <p className="px-2 py-3 text-[13px] leading-relaxed text-ink-faint">
            No conversations yet. Add a friend, then start one from their profile.
          </p>
        )}

        <ul className="space-y-0.5">
          {ordered.map((dm) => {
            const recipient = dm.recipients[0];
            if (!recipient) return null;

            const state = readStates[dm.id];
            const active = activeChannelId === dm.id;
            const unread = Boolean(state?.unread) && !active;

            return (
              <li key={dm.id} className="group/dm relative">
                <button
                  onClick={() => {
                    navigate(`/dm/${dm.id}`);
                    setMobilePane('chat');
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    openContextMenu({
                      x: event.clientX,
                      y: event.clientY,
                      items: [
                        {
                          label: 'Close conversation',
                          onSelect: async () => {
                            await api.delete(`/api/dms/${dm.id}`);
                            useAppStore.setState((state) => {
                              const next = { ...state.dmChannels };
                              delete next[dm.id];
                              return { dmChannels: next };
                            });
                            if (active) navigate('/friends');
                          },
                        },
                      ],
                    });
                  }}
                  className={clsx(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors',
                    active
                      ? 'bg-surface-4 text-ink'
                      : unread
                        ? 'text-ink hover:bg-surface-3'
                        : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
                  )}
                >
                  <Avatar
                    userId={recipient.id}
                    name={recipient.displayName}
                    src={recipient.avatarUrl}
                    size={32}
                    status={presence[recipient.id]?.status ?? 'offline'}
                    showStatus
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={clsx('block truncate text-[15px]', unread && 'font-semibold')}
                    >
                      {recipient.displayName}
                    </span>
                    {presence[recipient.id]?.customStatus && (
                      <span className="block truncate text-[11px] leading-tight text-ink-faint">
                        {presence[recipient.id]!.customStatus}
                      </span>
                    )}
                  </span>
                  <Badge count={state?.mentionCount ?? 0} />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
