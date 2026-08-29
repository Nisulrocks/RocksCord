/**
 * The far-left server rail.
 *
 * Each server is a button with a "pill" indicator on its left edge that grows on hover
 * and fills when the server is active or has unread messages. That single element carries
 * three states at once, which is why it is worth the small amount of animation code.
 */

import { useNavigate, useLocation } from 'react-router-dom';
import { Compass, Plus } from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { ServerAvatar } from '../ui/Avatar';
import { Badge } from '../ui/primitives';

export function ServerRail() {
  const navigate = useNavigate();
  const location = useLocation();

  const servers = useAppStore((s) => s.servers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const serverUnread = useAppStore((s) => s.serverUnread);
  const dmChannels = useAppStore((s) => s.dmChannels);
  const readStates = useAppStore((s) => s.readStates);
  const incoming = useAppStore((s) => s.incomingRequests);

  const openModal = useUiStore((s) => s.openModal);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const markRead = useAppStore((s) => s.markRead);

  /**
   * Clear every unread badge in a server.
   *
   * Done server-side: the client does not know the newest message id for channels it has
   * never opened, which is exactly the set someone reaches for this to clear.
   */
  const markServerRead = async (serverId: string) => {
    try {
      const result = await api.post<{ readStates: { channelId: string; lastReadMessageId: string }[] }>(
        `/api/users/@me/read-states/server/${serverId}`,
      );
      for (const state of result.readStates) markRead(state.channelId, state.lastReadMessageId);
    } catch {
      // Nothing was cleared; the badges simply stay, which is the honest outcome.
    }
  };
  const setMobilePane = useUiStore((s) => s.setMobilePane);

  const isHome = location.pathname.startsWith('/friends') || location.pathname.startsWith('/dm');

  // The home button aggregates unread DMs and pending friend requests.
  const homeMentions =
    Object.values(dmChannels).reduce(
      (total, dm) => total + (readStates[dm.id]?.unread ? 1 : 0),
      0,
    ) + incoming.length;

  const orderedServers = Object.values(servers).sort((a, b) =>
    a.createdAt === b.createdAt ? a.name.localeCompare(b.name) : a.createdAt - b.createdAt,
  );

  return (
    <nav
      className="flex h-full w-[72px] flex-col items-center gap-2 overflow-y-auto bg-surface-0 py-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      aria-label="Servers"
    >
      <RailButton
        active={isHome}
        unread={homeMentions > 0}
        mentions={homeMentions}
        label="Direct messages"
        onClick={() => {
          navigate('/friends');
          setMobilePane('chat');
        }}
      >
        <div
          className={clsx(
            'flex h-12 w-12 items-center justify-center overflow-hidden bg-surface-3',
            'transition-all duration-200',
            isHome ? 'rounded-2xl ring-2 ring-accent' : 'rounded-3xl group-hover:rounded-2xl',
          )}
        >
          <RocksCordGlyph />
        </div>
      </RailButton>

      <div className="my-1 h-px w-8 bg-line" />

      {orderedServers.map((server) => {
        const { unread, mentions } = serverUnread(server.id);
        return (
          <RailButton
            key={server.id}
            active={activeServerId === server.id}
            unread={unread}
            mentions={mentions}
            label={server.name}
            onClick={() => {
              navigate(`/channels/${server.id}`);
              setMobilePane('chat');
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              openContextMenu({
                x: event.clientX,
                y: event.clientY,
                items: [
                  {
                    label: 'Mark as read',
                    onSelect: () => void markServerRead(server.id),
                  },
                  {
                    label: 'Invite people',
                    onSelect: () => openModal({ kind: 'invite', serverId: server.id }),
                    separated: true,
                  },
                  {
                    label: 'Server settings',
                    onSelect: () => openModal({ kind: 'server-settings', serverId: server.id }),
                  },
                  {
                    label: 'Create channel',
                    onSelect: () => openModal({ kind: 'create-channel', serverId: server.id }),
                  },
                ],
              });
            }}
          >
            <ServerAvatar
              serverId={server.id}
              name={server.name}
              src={server.iconUrl}
              active={activeServerId === server.id}
            />
          </RailButton>
        );
      })}

      <RailButton
        label="Create a server"
        onClick={() => openModal({ kind: 'create-server' })}
        accent="online"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-3xl bg-surface-3 text-online transition-all duration-200 group-hover:rounded-2xl group-hover:bg-online group-hover:text-white">
          <Plus size={24} />
        </div>
      </RailButton>

      <RailButton
        label="Join with an invite"
        onClick={() => openModal({ kind: 'join-server' })}
        accent="teal"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-3xl bg-surface-3 text-teal transition-all duration-200 group-hover:rounded-2xl group-hover:bg-teal group-hover:text-white">
          <Compass size={22} />
        </div>
      </RailButton>
    </nav>
  );
}

function RailButton({
  children,
  active,
  unread,
  mentions = 0,
  label,
  onClick,
  onContextMenu,
}: {
  children: React.ReactNode;
  active?: boolean;
  unread?: boolean;
  mentions?: number;
  label: string;
  onClick: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  accent?: 'online' | 'teal';
}) {
  return (
    <div className="group relative flex w-full items-center justify-center">
      {/* The pill: 4px active, 20px unread, 20px on hover, invisible otherwise. */}
      <span
        aria-hidden
        className={clsx(
          'absolute left-0 w-1 rounded-r-full bg-ink transition-all duration-200',
          active
            ? 'h-10'
            : unread
              ? 'h-2 group-hover:h-5'
              : 'h-0 group-hover:h-5',
        )}
      />
      <button
        onClick={onClick}
        onContextMenu={onContextMenu}
        title={label}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className="relative outline-none"
      >
        {children}
        {mentions > 0 && (
          <Badge
            count={mentions}
            className="absolute -bottom-0.5 -right-0.5 border-2 border-surface-0"
          />
        )}
      </button>
    </div>
  );
}

/**
 * The home button's mark — the app icon itself.
 *
 * `object-contain` with a little padding keeps the character's silhouette intact inside
 * the square tile; cropping it would cut off the headset.
 */
function RocksCordGlyph() {
  return (
    <img
      src="/icon-192.png"
      alt=""
      width={44}
      height={44}
      className="h-11 w-11 object-contain p-0.5"
      draggable={false}
    />
  );
}
