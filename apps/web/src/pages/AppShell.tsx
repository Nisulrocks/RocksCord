/**
 * The main application layout.
 *
 *   ┌──────┬───────────────┬─────────────────────────┬──────────────┐
 *   │      │               │  channel header         │              │
 *   │ srvr │  channel      ├─────────────────────────┤   members    │
 *   │ rail │  sidebar      │  messages               │              │
 *   │      │               ├─────────────────────────┤              │
 *   │      │  user panel   │  composer               │              │
 *   └──────┴───────────────┴─────────────────────────┴──────────────┘
 *
 * The URL is the source of truth for what is open, so links, the back button, and a hard
 * refresh all behave. The store is synced *from* the route, never the other way around.
 *
 * Below 768px the three columns collapse into one pane at a time, switched by the store's
 * `mobilePane`, so the same components serve both layouts.
 */

import { useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import clsx from 'clsx';
import { useAppStore } from '../store/useAppStore';
import { useUiStore } from '../store/useUiStore';
import { ServerRail } from '../components/layout/ServerRail';
import { ChannelSidebar } from '../components/layout/ChannelSidebar';
import { HomeSidebar } from '../components/home/HomeSidebar';
import { MemberList } from '../components/layout/MemberList';
import { UserPanel } from '../components/layout/UserPanel';
import { ChatView } from '../components/chat/ChatView';
import { FriendsView } from '../components/home/FriendsView';
import { VoiceRoom } from '../components/voice/VoiceRoom';
import { ConnectionBanner } from '../components/layout/ConnectionBanner';
import { Spinner } from '../components/ui/primitives';

export function AppShell({ onLogout }: { onLogout: () => Promise<void> }) {
  const params = useParams<{ serverId?: string; channelId?: string }>();
  const navigate = useNavigate();

  const hydrated = useAppStore((s) => s.hydrated);
  const channels = useAppStore((s) => s.channels);
  const dmChannels = useAppStore((s) => s.dmChannels);
  const servers = useAppStore((s) => s.servers);
  const setActive = useAppStore((s) => s.setActive);
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const activeServerId = useAppStore((s) => s.activeServerId);

  const mobilePane = useUiStore((s) => s.mobilePane);
  const memberListOpen = useUiStore((s) => s.memberListOpen);

  const isDmRoute = location.pathname.startsWith('/dm');
  const isFriendsRoute = location.pathname.startsWith('/friends');

  /* -------------------------------------------------------------------- */
  /* Route -> store                                                        */
  /* -------------------------------------------------------------------- */

  useEffect(() => {
    if (!hydrated) return;

    if (isFriendsRoute) {
      setActive(null, null);
      return;
    }

    if (isDmRoute) {
      setActive(null, params.channelId ?? null);
      return;
    }

    const serverId = params.serverId ?? null;
    if (!serverId) return;

    // A server id that is not (or no longer) ours: bounce home rather than render a
    // broken shell. This is what happens when you are kicked while looking at a server.
    if (!servers[serverId]) {
      navigate('/friends', { replace: true });
      return;
    }

    if (params.channelId && channels[params.channelId]) {
      setActive(serverId, params.channelId);
      return;
    }

    // No channel in the URL (or it vanished): land on the first text channel.
    const firstText = Object.values(channels)
      .filter((c) => c.serverId === serverId && c.type === 'text')
      .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))[0];

    if (firstText) {
      navigate(`/channels/${serverId}/${firstText.id}`, { replace: true });
    } else {
      setActive(serverId, null);
    }
  }, [
    hydrated,
    isFriendsRoute,
    isDmRoute,
    params.serverId,
    params.channelId,
    channels,
    servers,
    setActive,
    navigate,
  ]);

  if (!hydrated) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-2">
        <div className="flex flex-col items-center gap-3 text-ink-faint">
          <Spinner size={26} />
          <span className="text-sm">Connecting…</span>
        </div>
      </div>
    );
  }

  const activeChannel = activeChannelId ? channels[activeChannelId] : null;
  const activeDm = activeChannelId ? dmChannels[activeChannelId] : null;
  const isVoiceChannel = activeChannel?.type === 'voice';

  return (
    <div className="flex h-full w-full overflow-hidden bg-surface-2">
      {/* Server rail: always visible on desktop, part of the sidebar pane on mobile. */}
      <div className={clsx('shrink-0', mobilePane === 'sidebar' ? 'flex' : 'hidden md:flex')}>
        <ServerRail />
      </div>

      {/* Channel / DM sidebar. */}
      <aside
        className={clsx(
          'w-full shrink-0 flex-col border-r border-line bg-surface-1 md:w-60',
          mobilePane === 'sidebar' ? 'flex' : 'hidden md:flex',
        )}
      >
        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto">
          {activeServerId ? <ChannelSidebar serverId={activeServerId} /> : <HomeSidebar />}
        </div>
        <UserPanel onLogout={onLogout} />
      </aside>

      {/* Main pane. */}
      <main
        className={clsx(
          'min-w-0 flex-1 flex-col',
          mobilePane === 'chat' ? 'flex' : 'hidden md:flex',
        )}
      >
        <ConnectionBanner />
        {isFriendsRoute ? (
          <FriendsView />
        ) : isVoiceChannel && activeChannel ? (
          <VoiceRoom channel={activeChannel} />
        ) : activeChannel || activeDm ? (
          <ChatView channelId={activeChannelId!} />
        ) : (
          <FriendsView />
        )}
      </main>

      {/* Member list: server channels only, and collapsible. */}
      {activeServerId && memberListOpen && !isVoiceChannel && (
        <aside
          className={clsx(
            'w-full shrink-0 border-l border-line bg-surface-1 md:w-60',
            mobilePane === 'members' ? 'block' : 'hidden md:block',
          )}
        >
          <MemberList serverId={activeServerId} />
        </aside>
      )}
    </div>
  );
}
