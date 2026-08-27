/**
 * The floating user profile popover.
 *
 * Opened by clicking an avatar or a mention anywhere in the app. It fetches the full
 * profile lazily — the store only holds the trimmed public projection, and the mutual
 * servers and role list are not worth carrying around for every user in every message.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, UserPlus } from 'lucide-react';
import clsx from 'clsx';
import type { PublicUser } from '@rockscord/shared';
import { api, ApiClientError } from '../lib/api';
import { useAppStore } from '../store/useAppStore';
import { useUiStore } from '../store/useUiStore';
import { Avatar, avatarColorFor } from './ui/Avatar';
import { Button, Spinner } from './ui/primitives';

const CARD_WIDTH = 320;
const MARGIN = 12;

interface ProfileResponse {
  user: PublicUser;
  mutualServerIds: string[];
}

export function ProfileCard() {
  const card = useUiStore((s) => s.profileCard);
  const close = useUiStore((s) => s.closeProfileCard);
  const toast = useUiStore((s) => s.toast);

  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loading, setLoading] = useState(false);

  const currentUser = useAppStore((s) => s.user);
  const servers = useAppStore((s) => s.servers);
  const activeServerId = useAppStore((s) => s.activeServerId);
  const membersByServer = useAppStore((s) => s.membersByServer);
  const roles = useAppStore((s) => s.roles);
  const presence = useAppStore((s) => (card ? s.presence[card.userId] : undefined));
  const friends = useAppStore((s) => s.friends);
  const outgoing = useAppStore((s) => s.outgoingRequests);
  const upsertFriendship = useAppStore((s) => s.upsertFriendship);

  /* Fetch ---------------------------------------------------------------- */

  useEffect(() => {
    if (!card) {
      setProfile(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setProfile(null);

    api
      .get<ProfileResponse>(`/api/users/${card.userId}`)
      .then((response) => {
        if (!cancelled) setProfile(response);
      })
      .catch(() => {
        if (!cancelled) close();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [card, close]);

  /* Positioning ----------------------------------------------------------- */

  useLayoutEffect(() => {
    if (!card || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();

    // Prefer opening to the right of the click, flipping left near the viewport edge,
    // and clamping vertically so the card is never cut off.
    let x = card.anchor.x + MARGIN;
    if (x + CARD_WIDTH > window.innerWidth - MARGIN) {
      x = Math.max(MARGIN, card.anchor.x - CARD_WIDTH - MARGIN);
    }
    const y = Math.min(
      Math.max(MARGIN, card.anchor.y - rect.height / 2),
      window.innerHeight - rect.height - MARGIN,
    );

    setPosition({ x, y });
  }, [card, profile]);

  useEffect(() => {
    if (!card) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const timer = window.setTimeout(
      () => document.addEventListener('pointerdown', onPointerDown),
      0,
    );
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
    };
  }, [card, close]);

  if (!card) return null;

  const user = profile?.user;
  const isSelf = card.userId === currentUser?.id;
  const isFriend = friends.some((f) => f.user.id === card.userId);
  const requested = outgoing.some((f) => f.user.id === card.userId);

  const member = activeServerId ? membersByServer[activeServerId]?.[card.userId] : undefined;
  const memberRoles = (member?.roleIds ?? [])
    .map((roleId) => roles[roleId])
    .filter((role): role is NonNullable<typeof role> => Boolean(role) && !role!.isDefault)
    .sort((a, b) => b.position - a.position);

  const mutual = (profile?.mutualServerIds ?? [])
    .map((id) => servers[id])
    .filter((server): server is NonNullable<typeof server> => Boolean(server));

  const sendFriendRequest = async () => {
    if (!user) return;
    try {
      const response = await api.post<{ friendship: Parameters<typeof upsertFriendship>[0] }>(
        '/api/friends/requests',
        { username: `${user.username}#${user.discriminator}` },
      );
      upsertFriendship(response.friendship);
      toast(`Friend request sent to ${user.displayName}`, 'success');
    } catch (error) {
      toast(
        error instanceof ApiClientError ? error.message : 'Could not send that request',
        'error',
      );
    }
  };

  const openDm = async () => {
    try {
      const response = await api.post<{ channel: { id: string } }>('/api/dms', {
        userId: card.userId,
      });
      close();
      window.location.assign(`/dm/${response.channel.id}`);
    } catch {
      toast('Could not open that conversation', 'error');
    }
  };

  return createPortal(
    <div
      ref={ref}
      className="animate-pop-in fixed z-[65] overflow-hidden rounded-panel border border-line-strong bg-surface-4 shadow-pop"
      style={{ left: position.x, top: position.y, width: CARD_WIDTH }}
    >
      {/* Banner, tinted from the same deterministic colour as the fallback avatar. */}
      <div className="h-16" style={{ background: avatarColorFor(card.userId) }} />

      <div className="px-4 pb-4">
        <div className="-mt-10 mb-3">
          <div className="inline-block rounded-full border-[5px] border-surface-4">
            <Avatar
              userId={card.userId}
              name={user?.displayName ?? '…'}
              src={user?.avatarUrl}
              size={72}
              status={presence?.status ?? 'offline'}
              showStatus
            />
          </div>
        </div>

        {loading && !user ? (
          <div className="flex items-center gap-2 py-4 text-ink-faint">
            <Spinner size={16} /> Loading profile…
          </div>
        ) : user ? (
          <>
            <h3 className="text-lg font-semibold leading-tight text-ink">{user.displayName}</h3>
            <p className="text-[13px] text-ink-dim">
              {user.username}
              <span className="text-ink-faint">#{user.discriminator}</span>
            </p>

            {presence?.customStatus && (
              <p className="mt-2 rounded-md bg-surface-2 px-2.5 py-1.5 text-[13px] text-ink-dim">
                {presence.customStatus}
              </p>
            )}

            {user.bio && (
              <>
                <Divider>About</Divider>
                <p className="text-[13px] leading-relaxed text-ink-dim">{user.bio}</p>
              </>
            )}

            {memberRoles.length > 0 && (
              <>
                <Divider>Roles</Divider>
                <div className="flex flex-wrap gap-1.5">
                  {memberRoles.map((role) => (
                    <span
                      key={role.id}
                      className="flex items-center gap-1.5 rounded border border-line bg-surface-2 px-2 py-0.5 text-[12px] text-ink-dim"
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: role.color }}
                      />
                      {role.name}
                    </span>
                  ))}
                </div>
              </>
            )}

            {mutual.length > 0 && (
              <>
                <Divider>Mutual servers — {mutual.length}</Divider>
                <div className="flex flex-wrap gap-1.5">
                  {mutual.slice(0, 6).map((server) => (
                    <span
                      key={server.id}
                      className="rounded border border-line bg-surface-2 px-2 py-0.5 text-[12px] text-ink-dim"
                    >
                      {server.name}
                    </span>
                  ))}
                </div>
              </>
            )}

            <Divider>Member since</Divider>
            <p className="text-[13px] text-ink-dim">
              {new Date(user.createdAt).toLocaleDateString([], {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              })}
            </p>

            {!isSelf && (
              <div className="mt-4 flex gap-2">
                <Button size="sm" block onClick={() => void openDm()}>
                  <MessageSquare size={14} />
                  Message
                </Button>
                {!isFriend && (
                  <Button
                    size="sm"
                    variant="secondary"
                    block
                    disabled={requested}
                    onClick={() => void sendFriendRequest()}
                  >
                    <UserPlus size={14} />
                    {requested ? 'Requested' : 'Add friend'}
                  </Button>
                )}
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

function Divider({ children }: { children: React.ReactNode }) {
  return (
    <div className={clsx('mb-1.5 mt-3 text-[10px] font-bold uppercase tracking-wider text-ink-faint')}>
      {children}
    </div>
  );
}
