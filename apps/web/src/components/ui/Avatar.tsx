/**
 * Avatar with a presence dot.
 *
 * When a user has no uploaded picture, the fallback is a coloured initial rather than a
 * generic silhouette. The colour is derived deterministically from the user id, so the
 * same person is always the same colour for everyone -- which makes a member list
 * scannable even before you have learned anyone's name.
 */

import { useState } from 'react';
import clsx from 'clsx';
import type { UserStatus } from '@rockscord/shared';
import { resolveAssetUrl } from '../../lib/api';

const FALLBACK_COLORS = [
  '#7c6cff',
  '#3fb6c9',
  '#3ecf8e',
  '#f0b232',
  '#f4526a',
  '#c56cf0',
  '#4c8dff',
  '#e07a5f',
];

/** FNV-1a over the id: stable across sessions, machines, and reloads. */
function colorFor(id: string): string {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length]!;
}

function initialsFor(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

const STATUS_COLOR: Record<UserStatus, string> = {
  online: 'bg-online',
  idle: 'bg-idle',
  dnd: 'bg-dnd',
  offline: 'bg-offline',
};

export interface AvatarProps {
  userId: string;
  name: string;
  src?: string | null;
  size?: number;
  status?: UserStatus;
  /** Render the presence dot. Off in places where presence is meaningless. */
  showStatus?: boolean;
  /** Ring shown while this user is talking in voice. */
  speaking?: boolean;
  className?: string;
}

export function Avatar({
  userId,
  name,
  src,
  size = 40,
  status,
  showStatus = false,
  speaking = false,
  className,
}: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : resolveAssetUrl(src);
  const dotSize = Math.max(10, Math.round(size * 0.32));

  return (
    <div
      className={clsx('relative shrink-0 select-none', className)}
      style={{ width: size, height: size }}
    >
      <div
        className={clsx(
          'flex h-full w-full items-center justify-center overflow-hidden rounded-full',
          'transition-shadow',
          speaking && 'ring-2 ring-online',
        )}
        style={{ background: url ? undefined : colorFor(userId) }}
      >
        {url ? (
          <img
            src={url}
            alt=""
            width={size}
            height={size}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover"
            // A broken avatar URL falls back to initials instead of a broken-image icon.
            onError={() => setFailed(true)}
          />
        ) : (
          <span
            className="font-semibold text-white"
            style={{ fontSize: Math.max(11, Math.round(size * 0.4)) }}
          >
            {initialsFor(name)}
          </span>
        )}
      </div>

      {showStatus && status && (
        <span
          // The dot sits in a cut-out ring the colour of the surface behind it, so it
          // reads as punched through the avatar rather than pasted on top.
          className={clsx(
            'absolute bottom-0 right-0 rounded-full border-[3px] border-surface-1',
            STATUS_COLOR[status],
          )}
          style={{ width: dotSize, height: dotSize }}
          title={status}
        />
      )}
    </div>
  );
}

/** Square avatar used for server icons, which fall back to the server's initials. */
export function ServerAvatar({
  serverId,
  name,
  src,
  size = 48,
  active,
  className,
}: {
  serverId: string;
  name: string;
  src?: string | null;
  size?: number;
  active?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const url = failed ? null : resolveAssetUrl(src);

  return (
    <div
      className={clsx(
        'flex items-center justify-center overflow-hidden transition-all duration-200',
        active ? 'rounded-2xl' : 'rounded-3xl group-hover:rounded-2xl',
        className,
      )}
      style={{
        width: size,
        height: size,
        background: url ? undefined : active ? 'var(--color-accent)' : 'var(--color-surface-3)',
      }}
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="h-full w-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => setFailed(true)}
        />
      ) : (
        <span
          className={clsx(
            'font-semibold transition-colors',
            active ? 'text-white' : 'text-ink-dim group-hover:text-ink',
          )}
          style={{ fontSize: Math.round(size * 0.32) }}
        >
          {initialsFor(name)}
        </span>
      )}
    </div>
  );
}

export { colorFor as avatarColorFor };
