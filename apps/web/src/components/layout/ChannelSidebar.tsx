/**
 * Channel list for the active server.
 *
 * Text and voice channels are grouped and independently collapsible. Voice channels show
 * their occupants inline, because knowing who is in a call before joining it is the whole
 * point of a persistent voice room.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  Hash,
  HeadphoneOff,
  MicOff,
  Plus,
  ScreenShare,
  Settings,
  UserPlus,
  Video,
  Volume2,
} from 'lucide-react';
import clsx from 'clsx';
import { Permission } from '@rockscord/shared';
import type { Channel, VoiceParticipant } from '@rockscord/shared';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { useVoiceStore } from '../../store/useVoiceStore';
import { usePermissions } from '../../hooks/usePermissions';
import { api, ApiClientError } from '../../lib/api';
import { setPeerVolume } from '../../lib/voice';
import { useVoiceSession } from '../../hooks/useVoiceSession';
import { Avatar } from '../ui/Avatar';
import { Badge, IconButton } from '../ui/primitives';

export function ChannelSidebar({ serverId }: { serverId: string }) {
  const navigate = useNavigate();

  const server = useAppStore((s) => s.servers[serverId]);
  const channelsForServer = useAppStore((s) => s.channelsForServer);
  const activeChannelId = useAppStore((s) => s.activeChannelId);
  const readStates = useAppStore((s) => s.readStates);
  const voiceParticipants = useAppStore((s) => s.voiceParticipants);

  const openModal = useUiStore((s) => s.openModal);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const setMobilePane = useUiStore((s) => s.setMobilePane);

  const permissions = usePermissions(serverId);
  const { join: joinVoice } = useVoiceSession();
  const activeVoiceChannelId = useVoiceStore((s) => s.channelId);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!server) return null;

  const all = channelsForServer(serverId);
  const textChannels = all.filter((c) => c.type === 'text');
  const voiceChannels = all.filter((c) => c.type === 'voice');

  const canManage = permissions.canInServer(Permission.MANAGE_CHANNELS);
  const canInvite = permissions.canInServer(Permission.CREATE_INVITE);
  const canEditServer = permissions.canInServer(Permission.MANAGE_SERVER);

  const openChannel = (channel: Channel) => {
    if (channel.type === 'voice') {
      void joinVoice(channel.id);
      return;
    }
    navigate(`/channels/${serverId}/${channel.id}`);
    setMobilePane('chat');
  };

  const channelContextMenu = (event: React.MouseEvent, channel: Channel) => {
    event.preventDefault();
    const items = [
      {
        label: 'Copy link',
        onSelect: () => {
          void navigator.clipboard.writeText(
            `${window.location.origin}/channels/${serverId}/${channel.id}`,
          );
          useUiStore.getState().toast('Channel link copied', 'success');
        },
      },
    ];

    if (canManage) {
      items.push(
        {
          label: 'Edit channel',
          onSelect: () => openModal({ kind: 'channel-settings', channelId: channel.id }),
        },
        {
          label: 'Delete channel',
          onSelect: () =>
            openModal({
              kind: 'confirm',
              title: `Delete #${channel.name}?`,
              body: 'Every message in this channel will be permanently removed. This cannot be undone.',
              confirmLabel: 'Delete channel',
              danger: true,
              onConfirm: async () => {
                await api.delete(`/api/channels/${channel.id}`);
              },
            }),
        },
      );
    }

    openContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <div className="flex flex-col">
      {/* Server header, doubling as the settings entry point. */}
      <button
        onClick={() =>
          canEditServer
            ? openModal({ kind: 'server-settings', serverId })
            : openModal({ kind: 'invite', serverId })
        }
        className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4 text-left transition-colors hover:bg-surface-3"
      >
        <span className="truncate text-[15px] font-semibold text-ink">{server.name}</span>
        <ChevronDown size={16} className="shrink-0 text-ink-dim" />
      </button>

      <div className="px-2 py-3">
        {canInvite && (
          <button
            onClick={() => openModal({ kind: 'invite', serverId })}
            className="mb-3 flex w-full items-center gap-2 rounded-md border border-dashed border-line-strong px-2.5 py-2 text-[13px] text-ink-dim transition-colors hover:border-accent hover:text-accent-soft"
          >
            <UserPlus size={15} />
            Invite people
          </button>
        )}

        {/* Text channels ------------------------------------------------- */}
        <Group
          label="Text channels"
          collapsed={collapsed.text ?? false}
          onToggle={() => setCollapsed((c) => ({ ...c, text: !c.text }))}
          onAdd={
            canManage
              ? () => openModal({ kind: 'create-channel', serverId, type: 'text' })
              : undefined
          }
          addLabel="Create text channel"
        >
          {textChannels.map((channel) => {
            const readState = readStates[channel.id];
            const isActive = activeChannelId === channel.id;
            const unread = readState?.unread && !isActive;

            // A collapsed group still shows channels that need attention.
            if (collapsed.text && !isActive && !unread) return null;

            return (
              <ChannelRow
                key={channel.id}
                icon={<Hash size={17} />}
                name={channel.name}
                active={isActive}
                unread={Boolean(unread)}
                mentions={readState?.mentionCount ?? 0}
                onClick={() => openChannel(channel)}
                onContextMenu={(e) => channelContextMenu(e, channel)}
                onSettings={
                  canManage
                    ? () => openModal({ kind: 'channel-settings', channelId: channel.id })
                    : undefined
                }
              />
            );
          })}
        </Group>

        {/* Voice channels ------------------------------------------------ */}
        {(voiceChannels.length > 0 || canManage) && (
          <Group
            label="Voice channels"
            collapsed={collapsed.voice ?? false}
            onToggle={() => setCollapsed((c) => ({ ...c, voice: !c.voice }))}
            onAdd={
              canManage
                ? () => openModal({ kind: 'create-channel', serverId, type: 'voice' })
                : undefined
            }
            addLabel="Create voice channel"
            className="mt-4"
          >
            {voiceChannels.map((channel) => {
              const occupants = voiceParticipants[channel.id] ?? [];
              if (collapsed.voice && occupants.length === 0) return null;

              return (
                <div key={channel.id}>
                  <ChannelRow
                    icon={<Volume2 size={17} />}
                    name={channel.name}
                    active={activeVoiceChannelId === channel.id}
                    unread={false}
                    mentions={0}
                    trailing={
                      occupants.length > 0 ? (
                        <span className="text-[11px] tabular-nums text-ink-faint">
                          {occupants.length}
                        </span>
                      ) : undefined
                    }
                    onClick={() => openChannel(channel)}
                    onContextMenu={(e) => channelContextMenu(e, channel)}
                    onSettings={
                      canManage
                        ? () => openModal({ kind: 'channel-settings', channelId: channel.id })
                        : undefined
                    }
                  />
                  {occupants.length > 0 && (
                    <ul className="mb-1 ml-6 space-y-0.5">
                      {occupants.map((participant) => (
                        <VoiceOccupant
                          key={participant.userId}
                          participant={participant}
                          serverId={serverId}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </Group>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function Group({
  label,
  collapsed,
  onToggle,
  onAdd,
  addLabel,
  children,
  className,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  addLabel?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="group/head mb-1 flex items-center justify-between pl-1 pr-0.5">
        <button
          onClick={onToggle}
          className="flex min-w-0 items-center gap-0.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-dim"
        >
          <ChevronDown
            size={12}
            className={clsx('transition-transform', collapsed && '-rotate-90')}
          />
          <span className="truncate">{label}</span>
        </button>
        {onAdd && (
          <button
            onClick={onAdd}
            title={addLabel}
            aria-label={addLabel}
            className="text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover/head:opacity-100 focus-visible:opacity-100"
          >
            <Plus size={16} />
          </button>
        )}
      </div>
      <div className="space-y-0.5">{children}</div>
    </section>
  );
}

function ChannelRow({
  icon,
  name,
  active,
  unread,
  mentions,
  trailing,
  onClick,
  onContextMenu,
  onSettings,
}: {
  icon: React.ReactNode;
  name: string;
  active: boolean;
  unread: boolean;
  mentions: number;
  trailing?: React.ReactNode;
  onClick: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onSettings?: () => void;
}) {
  return (
    <div className="group/row relative flex items-center">
      {/* Unread marker: a small bar at the left edge, like the server rail pill. */}
      {unread && !active && (
        <span
          aria-hidden
          className="absolute -left-2 h-2 w-1 rounded-r-full bg-ink"
        />
      )}
      <button
        onClick={onClick}
        onContextMenu={onContextMenu}
        className={clsx(
          'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 py-[6px] text-left transition-colors',
          active
            ? 'bg-surface-4 text-ink'
            : unread
              ? 'text-ink hover:bg-surface-3'
              : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
        )}
      >
        <span className="shrink-0 text-ink-faint">{icon}</span>
        <span className={clsx('truncate text-[15px]', unread && !active && 'font-semibold')}>
          {name}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {trailing}
          <Badge count={mentions} />
        </span>
      </button>

      {onSettings && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onSettings();
          }}
          title="Edit channel"
          aria-label={`Edit ${name}`}
          className="absolute right-1 text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover/row:opacity-100 focus-visible:opacity-100"
        >
          <Settings size={14} />
        </button>
      )}
    </div>
  );
}

/**
 * One person inside a voice channel, as shown in the sidebar.
 *
 * The status icons are the whole reason this list exists: knowing who is in a call, and
 * whether they can hear you or are on camera, is what you want *before* joining. They are
 * lucide icons rather than emoji so they inherit colour and size like everything else --
 * emoji render at whatever size and hue the platform decides, which is why muted and
 * deafened used to look like different-sized stickers.
 */
function VoiceOccupant({
  participant,
  serverId,
}: {
  participant: VoiceParticipant;
  serverId: string;
}) {
  const speaking = useVoiceStore((s) => s.speaking[participant.userId] ?? false);
  const currentUserId = useAppStore((s) => s.user?.id);
  const openProfileCard = useUiStore((s) => s.openProfileCard);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const toast = useUiStore((s) => s.toast);
  const permissions = usePermissions(serverId);

  const muted = participant.selfMute || participant.serverMute;
  const deafened = participant.selfDeaf || participant.serverDeaf;
  const isSelf = participant.userId === currentUserId;

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();

    const items: { label: string; onSelect: () => void; separated?: boolean }[] = [
      {
        label: 'View profile',
        onSelect: () =>
          openProfileCard({
            userId: participant.userId,
            anchor: { x: event.clientX, y: event.clientY },
          }),
      },
    ];

    /*
     * Per-person volume is local, so it only means anything while you are actually
     * connected to them -- setting it for someone you cannot hear would silently do
     * nothing. Hidden for yourself for the same reason.
     */
    if (!isSelf && useVoiceStore.getState().channelId === participant.channelId) {
      items.push(
        { label: 'Volume 100%', separated: true, onSelect: () => setPeerVolume(participant.userId, 1) },
        { label: 'Volume 50%', onSelect: () => setPeerVolume(participant.userId, 0.5) },
        { label: 'Mute for me', onSelect: () => setPeerVolume(participant.userId, 0) },
      );
    }

    /*
     * Moderation, on the server's authority rather than the person's own.
     *
     * Hidden for yourself: server mute is something done *to* someone, and the buttons for
     * silencing your own microphone are already in the panel below. Each entry is gated on
     * its own permission because muting and deafening are separate powers.
     */
    if (!isSelf) {
      const moderate = async (body: { serverMute?: boolean; serverDeaf?: boolean }) => {
        try {
          await api.patch(`/api/servers/${serverId}/members/${participant.userId}/voice`, body);
        } catch (error) {
          toast(
            error instanceof ApiClientError ? error.message : 'Could not do that',
            'error',
          );
        }
      };

      if (permissions.canInServer(Permission.MUTE_MEMBERS)) {
        items.push({
          label: participant.serverMute ? 'Un-mute on server' : 'Mute on server',
          separated: true,
          onSelect: () => void moderate({ serverMute: !participant.serverMute }),
        });
      }
      if (permissions.canInServer(Permission.DEAFEN_MEMBERS)) {
        items.push({
          label: participant.serverDeaf ? 'Un-deafen on server' : 'Deafen on server',
          onSelect: () => void moderate({ serverDeaf: !participant.serverDeaf }),
        });
      }
    }

    items.push({
      label: 'Copy user ID',
      separated: true,
      onSelect: () => {
        void navigator.clipboard.writeText(participant.userId);
        toast('Copied', 'success');
      },
    });

    openContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <li>
      <button
        type="button"
        onContextMenu={onContextMenu}
        onClick={(event) =>
          openProfileCard({
            userId: participant.userId,
            anchor: { x: event.clientX, y: event.clientY },
          })
        }
        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[13px] hover:bg-surface-3"
      >
        <Avatar
          userId={participant.userId}
          name={participant.user.displayName}
          src={participant.user.avatarUrl}
          size={22}
          speaking={speaking && !muted}
        />
        <span className={clsx('truncate', muted || deafened ? 'text-ink-faint' : 'text-ink-dim')}>
          {participant.user.displayName}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {participant.camera && <Video size={13} className="text-online" aria-label="On camera" />}
          {participant.streaming && (
            <ScreenShare size={13} className="text-online" aria-label="Sharing screen" />
          )}
          {deafened ? (
            <HeadphoneOff size={13} className="text-danger" aria-label="Deafened" />
          ) : muted ? (
            <MicOff size={13} className="text-danger" aria-label="Muted" />
          ) : null}
        </span>
      </button>
    </li>
  );
}
