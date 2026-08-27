/**
 * The right-hand member list.
 *
 * Members are grouped by their highest *hoisted* role (roles flagged to display
 * separately), with everyone else under "Online" or "Offline". Within each group they are
 * sorted by display name. Offline members are collapsed into their own group at the
 * bottom and dimmed, so an active server reads at a glance.
 *
 * The list is fetched once per server and then maintained purely by socket events.
 */

import { useEffect, useMemo, useState } from 'react';
import { Crown } from 'lucide-react';
import clsx from 'clsx';
import { Permission } from '@rockscord/shared';
import type { Member, Role } from '@rockscord/shared';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { usePermissions, useHighestRolePosition, useMemberRolePosition } from '../../hooks/usePermissions';
import { Avatar } from '../ui/Avatar';
import { Spinner } from '../ui/primitives';

interface Group {
  key: string;
  label: string;
  color: string | null;
  members: Member[];
}

export function MemberList({ serverId }: { serverId: string }) {
  const members = useAppStore((s) => s.membersByServer[serverId]);
  const setMembers = useAppStore((s) => s.setMembers);
  const rolesForServer = useAppStore((s) => s.rolesForServer);
  const presence = useAppStore((s) => s.presence);
  const server = useAppStore((s) => s.servers[serverId]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    api
      .get<{ members: Member[] }>(`/api/servers/${serverId}/members`)
      .then((response) => {
        if (!cancelled) setMembers(serverId, response.members);
      })
      .catch(() => {
        // A failed member list should not blank the channel; the sidebar just stays empty.
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [serverId, setMembers]);

  const roles = rolesForServer(serverId);

  const groups = useMemo<Group[]>(() => {
    const list = Object.values(members ?? {});
    if (list.length === 0) return [];

    const hoisted = roles.filter((role) => role.hoist && !role.isDefault);
    const buckets = new Map<string, Group>();

    for (const role of hoisted) {
      buckets.set(role.id, { key: role.id, label: role.name, color: role.color, members: [] });
    }
    buckets.set('online', { key: 'online', label: 'Online', color: null, members: [] });
    buckets.set('offline', { key: 'offline', label: 'Offline', color: null, members: [] });

    for (const member of list) {
      const isOnline = (presence[member.userId]?.status ?? 'offline') !== 'offline';

      if (!isOnline) {
        buckets.get('offline')!.members.push(member);
        continue;
      }

      // Highest hoisted role wins; `hoisted` is already sorted by descending position.
      const roleBucket = hoisted.find((role) => member.roleIds.includes(role.id));
      buckets.get(roleBucket?.id ?? 'online')!.members.push(member);
    }

    const nameOf = (member: Member) => member.nickname ?? member.user.displayName;

    return [...buckets.values()]
      .filter((group) => group.members.length > 0)
      .map((group) => ({
        ...group,
        members: group.members.sort((a, b) =>
          nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: 'base' }),
        ),
      }));
  }, [members, roles, presence]);

  if (loading && !members) {
    return (
      <div className="flex h-full items-center justify-center text-ink-faint">
        <Spinner size={20} />
      </div>
    );
  }

  return (
    <div className="scrollbar-slim h-full overflow-y-auto px-2 py-4">
      {groups.map((group) => (
        <section key={group.key} className="mb-5">
          <h3
            className="mb-1 px-2 text-[11px] font-bold uppercase tracking-wider"
            style={{ color: group.color ?? 'var(--color-ink-faint)' }}
          >
            {group.label} — {group.members.length}
          </h3>
          <ul>
            {group.members.map((member) => (
              <MemberRow
                key={member.userId}
                member={member}
                serverId={serverId}
                roles={roles}
                isOwner={server?.ownerId === member.userId}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function MemberRow({
  member,
  serverId,
  roles,
  isOwner,
}: {
  member: Member;
  serverId: string;
  roles: Role[];
  isOwner: boolean;
}) {
  const status = useAppStore((s) => s.presence[member.userId]?.status ?? 'offline');
  const customStatus = useAppStore((s) => s.presence[member.userId]?.customStatus);
  const currentUserId = useAppStore((s) => s.user?.id);

  const openProfileCard = useUiStore((s) => s.openProfileCard);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const openModal = useUiStore((s) => s.openModal);
  const toast = useUiStore((s) => s.toast);

  const permissions = usePermissions(serverId);
  const myPosition = useHighestRolePosition(serverId);
  const theirPosition = useMemberRolePosition(serverId, member.userId);

  const offline = status === 'offline';
  const name = member.nickname ?? member.user.displayName;

  // The highest coloured role tints the name, matching the member-list grouping.
  const color =
    member.roleIds
      .map((roleId) => roles.find((role) => role.id === roleId))
      .filter((role): role is Role => Boolean(role) && !role!.isDefault && role!.color !== '#99aab5')
      .sort((a, b) => b.position - a.position)[0]?.color ?? null;

  const canAct = member.userId !== currentUserId && myPosition > theirPosition;

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const items = [
      {
        label: 'View profile',
        onSelect: () =>
          openProfileCard({ userId: member.userId, anchor: { x: event.clientX, y: event.clientY } }),
      },
    ];

    if (member.userId !== currentUserId) {
      items.push({
        label: 'Send message',
        onSelect: async () => {
          const response = await api.post<{ channel: { id: string } }>('/api/dms', {
            userId: member.userId,
          });
          window.location.assign(`/dm/${response.channel.id}`);
        },
      });
    }

    if (canAct && permissions.canInServer(Permission.KICK_MEMBERS)) {
      items.push({
        label: 'Kick from server',
        danger: true,
        separated: true,
        onSelect: () =>
          openModal({
            kind: 'confirm',
            title: `Kick ${name}?`,
            body: 'They can rejoin with a new invite.',
            confirmLabel: 'Kick',
            danger: true,
            onConfirm: async () => {
              await api.delete(`/api/servers/${serverId}/members/${member.userId}`);
              toast(`${name} was removed`, 'success');
            },
          }),
      } as never);
    }

    if (canAct && permissions.canInServer(Permission.BAN_MEMBERS)) {
      items.push({
        label: 'Ban from server',
        danger: true,
        onSelect: () =>
          openModal({
            kind: 'confirm',
            title: `Ban ${name}?`,
            body: 'They will be removed and cannot rejoin until unbanned.',
            confirmLabel: 'Ban',
            danger: true,
            onConfirm: async () => {
                await api.post(`/api/servers/${serverId}/bans/${member.userId}`, {});
              toast(`${name} was banned`, 'success');
            },
          }),
      } as never);
    }

    openContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  return (
    <li>
      <button
        onClick={(event) =>
          openProfileCard({
            userId: member.userId,
            anchor: { x: event.clientX, y: event.clientY },
          })
        }
        onContextMenu={onContextMenu}
        className={clsx(
          'flex w-full items-center gap-2.5 rounded-md px-2 py-1 text-left transition-colors',
          'hover:bg-surface-3',
          offline && 'opacity-45 hover:opacity-100',
        )}
      >
        <Avatar
          userId={member.userId}
          name={name}
          src={member.user.avatarUrl}
          size={32}
          status={status}
          showStatus
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1">
            <span
              className="truncate text-[14px] font-medium"
              style={{ color: color ?? 'var(--color-ink-dim)' }}
            >
              {name}
            </span>
            {isOwner && (
              <Crown size={12} className="shrink-0 text-idle" aria-label="Server owner" />
            )}
          </span>
          {customStatus && (
            <span className="block truncate text-[11px] leading-tight text-ink-faint">
              {customStatus}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}
