/**
 * Bottom-left user panel: your identity, your voice controls, and settings.
 *
 * When you are in a voice call this panel grows a connection strip above it showing which
 * channel you are in and offering a disconnect button, so leaving a call never requires
 * navigating back to the channel you joined from.
 */

import { LogOut, Mic, MicOff, Headphones, HeadphoneOff, Settings, ScreenShare, PhoneOff, Signal } from 'lucide-react';
import clsx from 'clsx';
import type { UserStatus } from '@rockscord/shared';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { useVoiceStore } from '../../store/useVoiceStore';
import { useVoiceSession } from '../../hooks/useVoiceSession';
import { setPresenceStatus } from '../../lib/socket';
import { Avatar } from '../ui/Avatar';
import { IconButton } from '../ui/primitives';

const STATUS_LABEL: Record<UserStatus, string> = {
  online: 'Online',
  idle: 'Idle',
  dnd: 'Do not disturb',
  offline: 'Invisible',
};

export function UserPanel({ onLogout }: { onLogout: () => Promise<void> }) {
  const user = useAppStore((s) => s.user);
  const connected = useAppStore((s) => s.connected);
  const presence = useAppStore((s) => (user ? s.presence[user.id] : undefined));
  const channels = useAppStore((s) => s.channels);
  const servers = useAppStore((s) => s.servers);

  const openModal = useUiStore((s) => s.openModal);
  const openContextMenu = useUiStore((s) => s.openContextMenu);

  const voice = useVoiceSession();
  const peerStates = useVoiceStore((s) => s.peerStates);
  const speaking = useVoiceStore((s) => (user ? (s.speaking[user.id] ?? false) : false));

  if (!user) return null;

  const status = presence?.status ?? 'online';
  const voiceChannel = voice.channelId ? channels[voice.channelId] : null;
  const voiceServer = voiceChannel?.serverId ? servers[voiceChannel.serverId] : null;

  // Peer health, surfaced as a single word rather than per-peer noise.
  const peerValues = Object.values(peerStates);
  const quality =
    peerValues.length === 0
      ? 'ready'
      : peerValues.some((s) => s === 'failed')
        ? 'failed'
        : peerValues.every((s) => s === 'connected')
          ? 'connected'
          : 'connecting';

  const openStatusMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openContextMenu({
      x: rect.left,
      y: rect.top - 150,
      items: (['online', 'idle', 'dnd', 'offline'] as UserStatus[]).map((value) => ({
        label: STATUS_LABEL[value],
        onSelect: () => setPresenceStatus(value),
      })),
    });
  };

  return (
    <div className="shrink-0 border-t border-line">
      {/* Voice connection strip ------------------------------------------ */}
      {voice.channelId && voiceChannel && (
        <div className="border-b border-line bg-surface-0 px-2 py-2">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="min-w-0">
              <div
                className={clsx(
                  'flex items-center gap-1.5 text-[13px] font-semibold',
                  quality === 'failed'
                    ? 'text-danger'
                    : quality === 'connected'
                      ? 'text-online'
                      : 'text-idle',
                )}
              >
                <Signal size={14} />
                {quality === 'failed'
                  ? 'Connection failed'
                  : quality === 'connected'
                    ? 'Voice connected'
                    : quality === 'ready'
                      ? 'Voice ready'
                      : 'Connecting…'}
              </div>
              <div className="truncate text-[12px] text-ink-faint">
                {voiceChannel.name}
                {voiceServer ? ` / ${voiceServer.name}` : ''}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton
                label={voice.streaming ? 'Stop sharing' : 'Share your screen'}
                active={voice.streaming}
                onClick={() => void voice.toggleScreenShare()}
              >
                <ScreenShare size={16} />
              </IconButton>
              <IconButton label="Disconnect" tone="danger" onClick={voice.leave}>
                <PhoneOff size={16} />
              </IconButton>
            </div>
          </div>
        </div>
      )}

      {/* Identity + controls --------------------------------------------- */}
      <div className="flex items-center gap-1 bg-surface-0 px-2 py-2">
        <button
          onClick={openStatusMenu}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-surface-3"
          title="Change your status"
        >
          <Avatar
            userId={user.id}
            name={user.displayName}
            src={user.avatarUrl}
            size={32}
            status={connected ? status : 'offline'}
            showStatus
            speaking={speaking && !voice.selfMute}
          />
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold leading-tight text-ink">
              {user.displayName}
            </span>
            <span className="block truncate text-[11px] leading-tight text-ink-faint">
              {connected ? (presence?.customStatus ?? `${user.username}#${user.discriminator}`) : 'Reconnecting…'}
            </span>
          </span>
        </button>

        <div className="flex shrink-0 items-center">
          <IconButton
            label={voice.selfMute ? 'Unmute' : 'Mute'}
            onClick={voice.toggleMute}
            tone={voice.selfMute ? 'danger' : 'default'}
          >
            {voice.selfMute ? <MicOff size={17} /> : <Mic size={17} />}
          </IconButton>

          <IconButton
            label={voice.selfDeaf ? 'Undeafen' : 'Deafen'}
            onClick={voice.toggleDeafen}
            tone={voice.selfDeaf ? 'danger' : 'default'}
          >
            {voice.selfDeaf ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
          </IconButton>

          <IconButton label="Settings" onClick={() => openModal({ kind: 'user-settings' })}>
            <Settings size={17} />
          </IconButton>

          <IconButton
            label="Sign out"
            onClick={() =>
              openModal({
                kind: 'confirm',
                title: 'Sign out?',
                body: 'You will need to sign in again on this device.',
                confirmLabel: 'Sign out',
                onConfirm: onLogout,
              })
            }
          >
            <LogOut size={16} />
          </IconButton>
        </div>
      </div>
    </div>
  );
}
