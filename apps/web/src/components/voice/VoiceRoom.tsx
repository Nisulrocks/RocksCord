/**
 * Voice channel stage.
 *
 * Shows everyone in the channel as a tile, with a speaking ring driven by real audio
 * analysis rather than by mute state. When someone shares their screen the layout
 * switches to a focused view with the participants as a filmstrip.
 */

import { useEffect, useRef, useState } from 'react';
import {
  Headphones,
  HeadphoneOff,
  Menu,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  ScreenShare,
  Volume2,
} from 'lucide-react';
import clsx from 'clsx';
import { LIMITS } from '@rockscord/shared';
import type { Channel, VoiceParticipant } from '@rockscord/shared';
import { EMPTY_ARRAY, useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { useVoiceStore } from '../../store/useVoiceStore';
import { useVoiceSession } from '../../hooks/useVoiceSession';
import { getLocalScreenStream, getPeerVideoStream, setPeerVolume } from '../../lib/voice';
import { Avatar } from '../ui/Avatar';
import { Button, EmptyState, IconButton } from '../ui/primitives';

export function VoiceRoom({ channel }: { channel: Channel }) {
  const participants = useAppStore(
    (s) => s.voiceParticipants[channel.id] ?? EMPTY_ARRAY,
  );
  const currentUserId = useAppStore((s) => s.user?.id);
  const setMobilePane = useUiStore((s) => s.setMobilePane);
  const openContextMenu = useUiStore((s) => s.openContextMenu);

  const voice = useVoiceSession();
  const watching = useVoiceStore((s) => s.watching);
  const setWatching = useVoiceStore((s) => s.setWatching);

  const connectedHere = voice.channelId === channel.id;
  const streamer = participants.find((p) => p.streaming);

  // If the person we were watching stopped sharing, drop back to the grid.
  useEffect(() => {
    if (watching && !participants.some((p) => p.userId === watching && p.streaming)) {
      setWatching(null);
    }
  }, [watching, participants, setWatching]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-0">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface-2 px-3">
        <IconButton
          label="Show channels"
          onClick={() => setMobilePane('sidebar')}
          className="md:hidden"
        >
          <Menu size={18} />
        </IconButton>
        <Volume2 size={19} className="shrink-0 text-ink-faint" />
        <h1 className="truncate text-[15px] font-semibold text-ink">{channel.name}</h1>
        <span className="ml-auto text-[13px] text-ink-faint">
          {participants.length} connected
        </span>
      </header>

      <div className="min-h-0 flex-1 p-4">
        {participants.length === 0 ? (
          <EmptyState
            icon={<Volume2 size={44} />}
            title={`${channel.name} is empty`}
            body="Be the first to join. Anyone else in the server will see you here."
            action={
              <Button className="mt-2" onClick={() => void voice.join(channel.id)}>
                Join voice
              </Button>
            }
          />
        ) : watching ? (
          <FocusedStream
            participants={participants}
            watchingId={watching}
            currentUserId={currentUserId}
            onClose={() => setWatching(null)}
          />
        ) : (
          <div
            className={clsx(
              'grid h-full auto-rows-fr gap-3',
              participants.length <= 1
                ? 'grid-cols-1'
                : participants.length <= 4
                  ? 'grid-cols-2'
                  : 'grid-cols-2 lg:grid-cols-3',
            )}
          >
            {participants.map((participant) => (
              <ParticipantTile
                key={participant.userId}
                participant={participant}
                isSelf={participant.userId === currentUserId}
                onWatch={() => setWatching(participant.userId)}
                onContextMenu={(event) => {
                  if (participant.userId === currentUserId) return;
                  event.preventDefault();
                  openContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    items: [
                      {
                        label: 'Volume 100%',
                        onSelect: () => setPeerVolume(participant.userId, 1),
                      },
                      {
                        label: 'Volume 50%',
                        onSelect: () => setPeerVolume(participant.userId, 0.5),
                      },
                      {
                        label: 'Mute for me',
                        onSelect: () => setPeerVolume(participant.userId, 0),
                      },
                    ],
                  });
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Control bar ----------------------------------------------------- */}
      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-line bg-surface-2 px-4 py-3">
        {connectedHere ? (
          <>
            <ControlButton
              label={voice.selfMute ? 'Unmute' : 'Mute'}
              onClick={voice.toggleMute}
              active={voice.selfMute}
            >
              {voice.selfMute ? <MicOff size={20} /> : <Mic size={20} />}
            </ControlButton>

            <ControlButton
              label={voice.selfDeaf ? 'Undeafen' : 'Deafen'}
              onClick={voice.toggleDeafen}
              active={voice.selfDeaf}
            >
              {voice.selfDeaf ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
            </ControlButton>

            <ControlButton
              label={voice.streaming ? 'Stop sharing' : 'Share screen'}
              onClick={() => void voice.toggleScreenShare()}
              highlighted={voice.streaming}
            >
              <ScreenShare size={20} />
            </ControlButton>

            {streamer && !watching && (
              <ControlButton
                label={`Watch ${streamer.user.displayName}`}
                onClick={() => setWatching(streamer.userId)}
              >
                <Monitor size={20} />
              </ControlButton>
            )}

            <button
              onClick={voice.leave}
              className="ml-2 flex h-10 items-center gap-2 rounded-full bg-danger px-5 text-[14px] font-semibold text-white transition-colors hover:bg-danger-deep"
            >
              <PhoneOff size={17} />
              Disconnect
            </button>
          </>
        ) : (
          <Button size="lg" loading={voice.connecting} onClick={() => void voice.join(channel.id)}>
            Join voice channel
          </Button>
        )}
      </div>

      {participants.length > LIMITS.VOICE_CHANNEL_SOFT_CAP && (
        <p className="bg-idle/15 px-4 py-1.5 text-center text-[12px] text-idle">
          {participants.length} people connected. This is a peer-to-peer mesh, so audio
          quality may degrade beyond about {LIMITS.VOICE_CHANNEL_SOFT_CAP}.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function ParticipantTile({
  participant,
  isSelf,
  onWatch,
  onContextMenu,
}: {
  participant: VoiceParticipant;
  isSelf: boolean;
  onWatch: () => void;
  onContextMenu: (event: React.MouseEvent) => void;
}) {
  const speaking = useVoiceStore((s) => s.speaking[participant.userId] ?? false);
  const peerState = useVoiceStore((s) => s.peerStates[participant.userId]);

  const muted = participant.selfMute || participant.serverMute;
  const deafened = participant.selfDeaf || participant.serverDeaf;

  return (
    <div
      onContextMenu={onContextMenu}
      className={clsx(
        'relative flex flex-col items-center justify-center gap-3 rounded-panel',
        'border bg-surface-2 p-6 transition-colors',
        speaking && !muted ? 'border-online' : 'border-line',
      )}
    >
      <Avatar
        userId={participant.userId}
        name={participant.user.displayName}
        src={participant.user.avatarUrl}
        size={84}
        speaking={speaking && !muted}
      />

      <div className="text-center">
        <div className="flex items-center justify-center gap-1.5 text-[15px] font-medium text-ink">
          {participant.user.displayName}
          {isSelf && <span className="text-[12px] text-ink-faint">(you)</span>}
        </div>
        {!isSelf && peerState && peerState !== 'connected' && (
          <div className="mt-0.5 text-[12px] capitalize text-idle">{peerState}</div>
        )}
      </div>

      <div className="absolute right-3 top-3 flex items-center gap-1.5">
        {participant.streaming && (
          <button
            onClick={onWatch}
            title="Watch their screen"
            className="rounded-md bg-accent px-2 py-1 text-[11px] font-semibold text-white hover:bg-accent-soft"
          >
            LIVE
          </button>
        )}
        {deafened ? (
          <span className="rounded-md bg-danger/20 p-1.5 text-danger" title="Deafened">
            <HeadphoneOff size={14} />
          </span>
        ) : muted ? (
          <span className="rounded-md bg-danger/20 p-1.5 text-danger" title="Muted">
            <MicOff size={14} />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Full-size screen share with the other participants along the bottom. */
function FocusedStream({
  participants,
  watchingId,
  currentUserId,
  onClose,
}: {
  participants: VoiceParticipant[];
  watchingId: string;
  currentUserId: string | undefined;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [missing, setMissing] = useState(false);
  const watched = participants.find((p) => p.userId === watchingId);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    // Own share comes from the local capture; everyone else's from their peer connection.
    const stream =
      watchingId === currentUserId ? getLocalScreenStream() : getPeerVideoStream(watchingId);

    if (!stream) {
      setMissing(true);
      return;
    }

    setMissing(false);
    element.srcObject = stream;
    void element.play().catch(() => {});

    return () => {
      element.srcObject = null;
    };
  }, [watchingId, currentUserId, participants]);

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-panel border border-line bg-black">
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Muting the local echo of your own screen share; peer audio is separate.
          muted={watchingId === currentUserId}
          className="h-full w-full object-contain"
        />
        {missing && (
          <div className="absolute inset-0 flex items-center justify-center text-[14px] text-ink-faint">
            Waiting for the stream…
          </div>
        )}
        <div className="absolute left-3 top-3 rounded-md bg-black/70 px-2.5 py-1 text-[12px] text-white">
          {watched?.user.displayName ?? 'Unknown'} · screen
        </div>
        <button
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md bg-black/70 px-2.5 py-1 text-[12px] text-white hover:bg-black"
        >
          Back to grid
        </button>
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto pb-1">
        {participants.map((participant) => (
          <FilmstripTile key={participant.userId} participant={participant} />
        ))}
      </div>
    </div>
  );
}

function FilmstripTile({ participant }: { participant: VoiceParticipant }) {
  const speaking = useVoiceStore((s) => s.speaking[participant.userId] ?? false);
  const muted = participant.selfMute || participant.serverMute;

  return (
    <div
      className={clsx(
        'flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2',
        speaking && !muted ? 'border-online bg-surface-2' : 'border-line bg-surface-2',
      )}
    >
      <Avatar
        userId={participant.userId}
        name={participant.user.displayName}
        src={participant.user.avatarUrl}
        size={28}
        speaking={speaking && !muted}
      />
      <span className="max-w-[140px] truncate text-[13px] text-ink-dim">
        {participant.user.displayName}
      </span>
      {muted && <MicOff size={13} className="text-danger" />}
    </div>
  );
}

function ControlButton({
  label,
  onClick,
  active,
  highlighted,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  highlighted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active || highlighted}
      className={clsx(
        'flex h-10 w-10 items-center justify-center rounded-full transition-colors',
        active
          ? 'bg-danger text-white hover:bg-danger-deep'
          : highlighted
            ? 'bg-accent text-white hover:bg-accent-soft'
            : 'bg-surface-4 text-ink-dim hover:bg-line-strong hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}
