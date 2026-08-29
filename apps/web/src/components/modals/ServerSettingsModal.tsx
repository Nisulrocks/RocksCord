/**
 * Server settings: overview, roles, members, invites, audit log.
 *
 * The roles tab is the interesting one — it edits permission bitfields directly, and
 * enforces client-side the same two rules the server enforces: you cannot grant a
 * permission you lack, and you cannot edit a role at or above your own.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ImagePlus, Plus, Shield, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import {
  ALL_PERMISSIONS,
  LIMITS,
  Permission,
  hasPermission,
} from '@rockscord/shared';
import type { Member, Role, Server } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { usePermissions, useHighestRolePosition } from '../../hooks/usePermissions';
import { EmojiTab } from './settings/EmojiTab';
import { Modal } from '../ui/Modal';
import { Avatar, ServerAvatar } from '../ui/Avatar';
import { Button, Field, Input, Textarea, Spinner, Toggle } from '../ui/primitives';

type Tab = 'overview' | 'roles' | 'emoji' | 'members' | 'invites' | 'audit';

/** Every permission, grouped for a readable editor. */
const PERMISSION_GROUPS: { title: string; permissions: { bit: number; label: string }[] }[] = [
  {
    title: 'General',
    permissions: [
      { bit: Permission.VIEW_CHANNEL, label: 'View channels' },
      { bit: Permission.MANAGE_CHANNELS, label: 'Manage channels' },
      { bit: Permission.MANAGE_ROLES, label: 'Manage roles' },
      { bit: Permission.MANAGE_SERVER, label: 'Manage server' },
      { bit: Permission.VIEW_AUDIT_LOG, label: 'View audit log' },
      { bit: Permission.CREATE_INVITE, label: 'Create invites' },
    ],
  },
  {
    title: 'Membership',
    permissions: [
      { bit: Permission.KICK_MEMBERS, label: 'Kick members' },
      { bit: Permission.BAN_MEMBERS, label: 'Ban members' },
      { bit: Permission.MANAGE_NICKNAMES, label: 'Manage nicknames' },
    ],
  },
  {
    title: 'Messages',
    permissions: [
      { bit: Permission.SEND_MESSAGES, label: 'Send messages' },
      { bit: Permission.READ_MESSAGE_HISTORY, label: 'Read message history' },
      { bit: Permission.ATTACH_FILES, label: 'Attach files' },
      { bit: Permission.ADD_REACTIONS, label: 'Add reactions' },
      { bit: Permission.MANAGE_MESSAGES, label: 'Manage messages' },
      { bit: Permission.MENTION_EVERYONE, label: 'Mention @everyone' },
    ],
  },
  {
    title: 'Voice',
    permissions: [
      { bit: Permission.CONNECT, label: 'Connect to voice' },
      { bit: Permission.SPEAK, label: 'Speak' },
      { bit: Permission.VIDEO, label: 'Share screen' },
      { bit: Permission.MUTE_MEMBERS, label: 'Mute members' },
      { bit: Permission.DEAFEN_MEMBERS, label: 'Deafen members' },
      { bit: Permission.MOVE_MEMBERS, label: 'Disconnect members' },
    ],
  },
  {
    title: 'Danger',
    permissions: [{ bit: Permission.ADMINISTRATOR, label: 'Administrator' }],
  },
];

export function ServerSettingsModal({
  serverId,
  initialTab = 'overview',
  onClose,
}: {
  serverId: string;
  initialTab?: Tab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const server = useAppStore((s) => s.servers[serverId]);
  const permissions = usePermissions(serverId);

  if (!server) return null;

  const tabs: { key: Tab; label: string; visible: boolean }[] = [
    { key: 'overview', label: 'Overview', visible: true },
    { key: 'roles', label: 'Roles', visible: permissions.canInServer(Permission.MANAGE_ROLES) },
    {
      key: 'emoji',
      label: 'Emoji',
      visible: permissions.canInServer(Permission.MANAGE_SERVER),
    },
    { key: 'members', label: 'Members', visible: true },
    {
      key: 'invites',
      label: 'Invites',
      visible: permissions.canInServer(Permission.MANAGE_SERVER),
    },
    {
      key: 'audit',
      label: 'Audit log',
      visible: permissions.canInServer(Permission.VIEW_AUDIT_LOG),
    },
  ];

  return (
    <Modal open onClose={onClose} title={server.name} subtitle="Server settings" width="xl">
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-line [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {tabs
          .filter((item) => item.visible)
          .map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={clsx(
                '-mb-px shrink-0 border-b-2 px-3 py-2 text-[14px] transition-colors',
                tab === item.key
                  ? 'border-accent text-ink'
                  : 'border-transparent text-ink-dim hover:text-ink',
              )}
            >
              {item.label}
            </button>
          ))}
      </nav>

      {tab === 'overview' && <OverviewTab server={server} onClose={onClose} />}
      {tab === 'roles' && <RolesTab serverId={serverId} />}
      {tab === 'members' && <MembersTab serverId={serverId} />}
      {tab === 'invites' && <InvitesTab serverId={serverId} />}
      {tab === 'emoji' && <EmojiTab serverId={serverId} />}
      {tab === 'audit' && <AuditTab serverId={serverId} />}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

function OverviewTab({ server, onClose }: { server: Server; onClose: () => void }) {
  const navigate = useNavigate();
  const upsertServer = useAppStore((s) => s.upsertServer);
  const currentUserId = useAppStore((s) => s.user?.id);
  const openModal = useUiStore((s) => s.openModal);
  const toast = useUiStore((s) => s.toast);
  const permissions = usePermissions(server.id);

  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(server.name);
  const [description, setDescription] = useState(server.description ?? '');
  const [saving, setSaving] = useState(false);

  const canManage = permissions.canInServer(Permission.MANAGE_SERVER);
  const isOwner = server.ownerId === currentUserId;

  const save = async () => {
    setSaving(true);
    try {
      const response = await api.patch<{ server: Server }>(`/api/servers/${server.id}`, {
        name: name.trim(),
        description: description.trim() || null,
      });
      upsertServer(response.server);
      toast('Server updated', 'success');
    } catch (error) {
      toast(
        error instanceof ApiClientError ? error.message : 'Could not save those changes',
        'error',
      );
    } finally {
      setSaving(false);
    }
  };

  const uploadIcon = async (file: File | undefined) => {
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await api.upload<{ iconUrl: string }>(
        `/api/files/icon/${server.id}`,
        formData,
      );
      upsertServer({ ...server, iconUrl: response.iconUrl });
      toast('Icon updated', 'success');
    } catch (error) {
      toast(error instanceof ApiClientError ? error.message : 'Icon upload failed', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <button
          onClick={() => canManage && fileRef.current?.click()}
          disabled={!canManage}
          className="group relative overflow-hidden rounded-2xl disabled:cursor-default"
        >
          <ServerAvatar
            serverId={server.id}
            name={server.name}
            src={server.iconUrl}
            size={80}
            active
          />
          {canManage && (
            <span className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
              <ImagePlus size={22} className="text-white" />
            </span>
          )}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => void uploadIcon(event.target.files?.[0])}
        />
        <div className="text-[13px] text-ink-dim">
          <div className="font-medium text-ink">Server icon</div>
          <div className="text-ink-faint">PNG, JPG, GIF or WebP. Up to 2 MB.</div>
        </div>
      </div>

      <Field label="Server name" required>
        <Input
          value={name}
          disabled={!canManage}
          maxLength={LIMITS.SERVER_NAME_MAX}
          onChange={(event) => setName(event.target.value)}
        />
      </Field>

      <Field label="Description" hint="Shown to people opening an invite link.">
        <Textarea
          rows={3}
          value={description}
          disabled={!canManage}
          maxLength={LIMITS.SERVER_DESCRIPTION_MAX}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>

      {canManage && (
        <Button onClick={() => void save()} loading={saving}>
          Save changes
        </Button>
      )}

      <div className="mt-8 rounded-lg border border-danger/40 bg-danger/5 p-4">
        <h4 className="text-[14px] font-semibold text-danger">Danger zone</h4>
        {isOwner ? (
          <>
            <p className="mt-1 text-[13px] text-ink-dim">
              Deleting a server removes every channel, message, and membership permanently.
            </p>
            <Button
              variant="danger"
              size="sm"
              className="mt-3"
              onClick={() =>
                openModal({
                  kind: 'confirm',
                  title: `Delete ${server.name}?`,
                  body: 'Every channel, message, role, and membership will be permanently removed. This cannot be undone.',
                  confirmLabel: 'Delete server',
                  danger: true,
                  onConfirm: async () => {
                    await api.delete(`/api/servers/${server.id}`);
                    onClose();
                    navigate('/friends');
                  },
                })
              }
            >
              <Trash2 size={14} />
              Delete server
            </Button>
          </>
        ) : (
          <>
            <p className="mt-1 text-[13px] text-ink-dim">
              You will need a new invite to come back.
            </p>
            <Button
              variant="danger"
              size="sm"
              className="mt-3"
              onClick={() =>
                openModal({
                  kind: 'confirm',
                  title: `Leave ${server.name}?`,
                  body: 'You will need a new invite to rejoin.',
                  confirmLabel: 'Leave server',
                  danger: true,
                  onConfirm: async () => {
                    await api.post(`/api/servers/${server.id}/leave`);
                    onClose();
                    navigate('/friends');
                  },
                })
              }
            >
              Leave server
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Roles                                                                       */
/* -------------------------------------------------------------------------- */

function RolesTab({ serverId }: { serverId: string }) {
  const rolesForServer = useAppStore((s) => s.rolesForServer);
  const upsertRole = useAppStore((s) => s.upsertRole);
  const removeRole = useAppStore((s) => s.removeRole);
  const openModal = useUiStore((s) => s.openModal);
  const toast = useUiStore((s) => s.toast);

  const permissions = usePermissions(serverId);
  const myPosition = useHighestRolePosition(serverId);

  const roles = rolesForServer(serverId);
  const [selectedId, setSelectedId] = useState<string | null>(roles[0]?.id ?? null);
  const [saving, setSaving] = useState(false);

  const selected = roles.find((role) => role.id === selectedId) ?? roles[0] ?? null;
  const editable = selected ? permissions.isOwner || selected.position < myPosition : false;

  const [draft, setDraft] = useState<Role | null>(selected);

  useEffect(() => {
    setDraft(selected);
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const createRole = async () => {
    try {
      const response = await api.post<{ role: Role }>(`/api/servers/${serverId}/roles`, {
        name: 'new role',
        color: '#7c6cff',
        permissions: 0,
      });
      upsertRole(response.role);
      setSelectedId(response.role.id);
    } catch (error) {
      toast(error instanceof ApiClientError ? error.message : 'Could not create a role', 'error');
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const response = await api.patch<{ role: Role }>(
        `/api/servers/${serverId}/roles/${draft.id}`,
        {
          name: draft.name,
          color: draft.color,
          permissions: draft.permissions,
          hoist: draft.hoist,
          mentionable: draft.mentionable,
        },
      );
      upsertRole(response.role);
      toast('Role saved', 'success');
    } catch (error) {
      toast(error instanceof ApiClientError ? error.message : 'Could not save that role', 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex gap-4">
      <div className="w-44 shrink-0">
        <Button size="sm" block onClick={() => void createRole()} className="mb-2">
          <Plus size={14} />
          New role
        </Button>
        <ul className="space-y-0.5">
          {roles.map((role) => (
            <li key={role.id}>
              <button
                onClick={() => setSelectedId(role.id)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                  selected?.id === role.id
                    ? 'bg-surface-4 text-ink'
                    : 'text-ink-dim hover:bg-surface-3',
                )}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ background: role.color }}
                />
                <span className="truncate">{role.name}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="min-w-0 flex-1">
        {!draft ? (
          <p className="text-[14px] text-ink-faint">Select a role to edit it.</p>
        ) : (
          <>
            {!editable && (
              <p className="mb-3 rounded-lg border border-idle/40 bg-idle/10 px-3 py-2 text-[13px] text-idle">
                This role sits at or above your highest role, so you cannot edit it.
              </p>
            )}

            <div className="grid grid-cols-2 gap-3">
              <Field label="Role name">
                <Input
                  value={draft.name}
                  disabled={!editable || draft.isDefault}
                  maxLength={LIMITS.ROLE_NAME_MAX}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </Field>
              <Field label="Colour">
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={draft.color}
                    disabled={!editable}
                    onChange={(event) => setDraft({ ...draft, color: event.target.value })}
                    className="h-10 w-14 cursor-pointer rounded border border-line bg-surface-0"
                  />
                  <Input
                    value={draft.color}
                    disabled={!editable}
                    onChange={(event) => setDraft({ ...draft, color: event.target.value })}
                  />
                </div>
              </Field>
            </div>

            <div className="mt-2 space-y-1 border-y border-line py-2">
              <Toggle
                checked={draft.hoist}
                disabled={!editable}
                onChange={(next) => setDraft({ ...draft, hoist: next })}
                label="Display separately"
                description="Show members with this role in their own member-list group."
              />
              <Toggle
                checked={draft.mentionable}
                disabled={!editable}
                onChange={(next) => setDraft({ ...draft, mentionable: next })}
                label="Allow anyone to @mention this role"
              />
            </div>

            <div className="mt-4 space-y-4">
              {PERMISSION_GROUPS.map((group) => (
                <section key={group.title}>
                  <h4
                    className={clsx(
                      'mb-1 text-[11px] font-bold uppercase tracking-wider',
                      group.title === 'Danger' ? 'text-danger' : 'text-ink-faint',
                    )}
                  >
                    {group.title}
                  </h4>
                  <div className="space-y-0.5">
                    {group.permissions.map((permission) => {
                      // You cannot grant what you do not hold, so those toggles are locked.
                      const allowed =
                        permissions.isOwner ||
                        hasPermission(permissions.base, permission.bit);

                      return (
                        <Toggle
                          key={permission.bit}
                          checked={(draft.permissions & permission.bit) !== 0}
                          disabled={!editable || !allowed}
                          onChange={(next) =>
                            setDraft({
                              ...draft,
                              permissions: next
                                ? draft.permissions | permission.bit
                                : draft.permissions & ~permission.bit,
                            })
                          }
                          label={permission.label}
                          description={
                            !allowed ? 'You do not have this permission yourself.' : undefined
                          }
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>

            {editable && (
              <div className="mt-5 flex items-center gap-2">
                <Button onClick={() => void save()} loading={saving}>
                  Save role
                </Button>
                {!draft.isDefault && (
                  <Button
                    variant="danger"
                    onClick={() =>
                      openModal({
                        kind: 'confirm',
                        title: `Delete the "${draft.name}" role?`,
                        body: 'Members will lose this role and any permissions it granted.',
                        confirmLabel: 'Delete role',
                        danger: true,
                        onConfirm: async () => {
                          await api.delete(`/api/servers/${serverId}/roles/${draft.id}`);
                          removeRole(serverId, draft.id);
                          setSelectedId(null);
                        },
                      })
                    }
                  >
                    <Trash2 size={14} />
                    Delete
                  </Button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Members                                                                     */
/* -------------------------------------------------------------------------- */

function MembersTab({ serverId }: { serverId: string }) {
  const members = useAppStore((s) => s.membersByServer[serverId]);
  const setMembers = useAppStore((s) => s.setMembers);
  const upsertMember = useAppStore((s) => s.upsertMember);
  const rolesForServer = useAppStore((s) => s.rolesForServer);
  const server = useAppStore((s) => s.servers[serverId]);
  const toast = useUiStore((s) => s.toast);

  const permissions = usePermissions(serverId);
  const myPosition = useHighestRolePosition(serverId);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api
      .get<{ members: Member[] }>(`/api/servers/${serverId}/members`)
      .then((response) => setMembers(serverId, response.members))
      .catch(() => toast('Could not load members', 'error'));
  }, [serverId, setMembers, toast]);

  const roles = rolesForServer(serverId).filter((role) => !role.isDefault);
  const list = Object.values(members ?? {}).filter((member) => {
    const term = query.trim().toLowerCase();
    if (!term) return true;
    return (
      member.user.displayName.toLowerCase().includes(term) ||
      member.user.username.toLowerCase().includes(term)
    );
  });

  const toggleRole = async (member: Member, roleId: string) => {
    const next = member.roleIds.includes(roleId)
      ? member.roleIds.filter((id) => id !== roleId)
      : [...member.roleIds, roleId];

    try {
      const response = await api.patch<{ member: Member }>(
        `/api/servers/${serverId}/members/${member.userId}`,
        { roleIds: next },
      );
      upsertMember(response.member);
    } catch (error) {
      toast(
        error instanceof ApiClientError ? error.message : 'Could not change that role',
        'error',
      );
    }
  };

  const canManageRoles = permissions.canInServer(Permission.MANAGE_ROLES);

  return (
    <div>
      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search members"
        className="mb-3"
      />

      {!members ? (
        <div className="flex items-center gap-2 py-6 text-ink-faint">
          <Spinner size={16} /> Loading members…
        </div>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((member) => {
            const theirPosition = member.roleIds.reduce((max, roleId) => {
              const role = roles.find((r) => r.id === roleId);
              return Math.max(max, role?.position ?? 0);
            }, 0);
            const isTheOwner = server?.ownerId === member.userId;
            const canEdit =
              canManageRoles && !isTheOwner && (permissions.isOwner || myPosition > theirPosition);

            return (
              <li key={member.userId} className="flex items-start gap-3 py-3">
                <Avatar
                  userId={member.userId}
                  name={member.user.displayName}
                  src={member.user.avatarUrl}
                  size={36}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
                    {member.nickname ?? member.user.displayName}
                    {isTheOwner && (
                      <span className="rounded bg-idle/20 px-1.5 text-[10px] font-bold uppercase text-idle">
                        Owner
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-ink-faint">
                    {member.user.username}#{member.user.discriminator}
                  </div>

                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {roles.map((role) => {
                      const active = member.roleIds.includes(role.id);
                      return (
                        <button
                          key={role.id}
                          disabled={!canEdit}
                          onClick={() => void toggleRole(member, role.id)}
                          className={clsx(
                            'flex items-center gap-1.5 rounded border px-2 py-0.5 text-[12px] transition-colors',
                            active
                              ? 'border-transparent text-ink'
                              : 'border-line text-ink-faint hover:text-ink-dim',
                            !canEdit && 'cursor-default opacity-60',
                          )}
                          style={active ? { background: `${role.color}30` } : undefined}
                        >
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: role.color }}
                          />
                          {role.name}
                        </button>
                      );
                    })}
                    {roles.length === 0 && (
                      <span className="text-[12px] text-ink-faint">
                        No custom roles yet — create one in the Roles tab.
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Invites & audit log                                                         */
/* -------------------------------------------------------------------------- */

interface InviteRow {
  code: string;
  uses: number;
  maxUses: number | null;
  expiresAt: number | null;
  createdAt: number;
}

function InvitesTab({ serverId }: { serverId: string }) {
  const [invites, setInvites] = useState<InviteRow[] | null>(null);
  const toast = useUiStore((s) => s.toast);

  const load = () =>
    api
      .get<{ invites: InviteRow[] }>(`/api/invites/server/${serverId}`)
      .then((response) => setInvites(response.invites))
      .catch(() => toast('Could not load invites', 'error'));

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  if (!invites) {
    return (
      <div className="flex items-center gap-2 py-6 text-ink-faint">
        <Spinner size={16} /> Loading invites…
      </div>
    );
  }

  if (invites.length === 0) {
    return (
      <p className="py-6 text-[14px] text-ink-faint">
        No invites yet. Create one from the Invite people button in the sidebar.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-line">
      {invites.map((invite) => (
        <li key={invite.code} className="flex items-center gap-3 py-3">
          <code className="rounded bg-surface-0 px-2 py-1 text-[13px] text-accent-soft">
            {invite.code}
          </code>
          <div className="min-w-0 flex-1 text-[12px] text-ink-faint">
            {invite.uses} {invite.uses === 1 ? 'use' : 'uses'}
            {invite.maxUses ? ` of ${invite.maxUses}` : ''}
            {invite.expiresAt
              ? ` · expires ${new Date(invite.expiresAt).toLocaleString()}`
              : ' · never expires'}
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.delete(`/api/invites/${invite.code}`);
              toast('Invite revoked', 'success');
              void load();
            }}
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

interface AuditEntry {
  id: string;
  action: string;
  actor: { displayName: string } | null;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

function AuditTab({ serverId }: { serverId: string }) {
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    api
      .get<{ entries: AuditEntry[] }>(`/api/servers/${serverId}/audit-log`)
      .then((response) => setEntries(response.entries))
      .catch(() => setEntries([]));
  }, [serverId]);

  if (!entries) {
    return (
      <div className="flex items-center gap-2 py-6 text-ink-faint">
        <Spinner size={16} /> Loading audit log…
      </div>
    );
  }

  if (entries.length === 0) {
    return <p className="py-6 text-[14px] text-ink-faint">Nothing has been logged yet.</p>;
  }

  return (
    <ul className="divide-y divide-line">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-start gap-3 py-2.5">
          <Shield size={15} className="mt-0.5 shrink-0 text-ink-faint" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] text-ink">
              <span className="font-medium">{entry.actor?.displayName ?? 'Someone'}</span>{' '}
              <span className="text-ink-dim">{entry.action.replace(/\./g, ' ')}</span>
            </div>
            {entry.metadata && (
              <div className="truncate text-[12px] text-ink-faint">
                {JSON.stringify(entry.metadata)}
              </div>
            )}
          </div>
          <time className="shrink-0 text-[12px] text-ink-faint">
            {new Date(entry.createdAt).toLocaleString()}
          </time>
        </li>
      ))}
    </ul>
  );
}

export { ALL_PERMISSIONS };
