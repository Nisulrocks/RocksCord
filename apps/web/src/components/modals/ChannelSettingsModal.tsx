/**
 * Channel settings: name, topic, and per-role permission overwrites.
 *
 * The permissions tab is where the role system becomes concrete. Each permission is a
 * three-state control — inherit / allow / deny — which maps directly onto the allow and
 * deny bitmasks the server stores. "Inherit" means neither bit is set, which is different
 * from "deny" and is exactly why a plain checkbox would not do.
 */

import { useEffect, useState } from 'react';
import { Check, Minus, X } from 'lucide-react';
import clsx from 'clsx';
import { LIMITS, Permission, listPermissions } from '@rockscord/shared';
import type { Channel, ChannelOverwrite, Role } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { Modal } from '../ui/Modal';
import { Button, Field, Input, Textarea, Spinner } from '../ui/primitives';

type Tab = 'overview' | 'permissions';

/** Permissions worth exposing per channel, with human labels. */
const CHANNEL_PERMISSIONS: { bit: number; label: string; hint: string }[] = [
  { bit: Permission.VIEW_CHANNEL, label: 'View channel', hint: 'See the channel and read it.' },
  { bit: Permission.SEND_MESSAGES, label: 'Send messages', hint: 'Post in this channel.' },
  {
    bit: Permission.READ_MESSAGE_HISTORY,
    label: 'Read history',
    hint: 'Load messages sent before joining.',
  },
  { bit: Permission.ATTACH_FILES, label: 'Attach files', hint: 'Upload images and files.' },
  { bit: Permission.ADD_REACTIONS, label: 'Add reactions', hint: 'React with emoji.' },
  {
    bit: Permission.MANAGE_MESSAGES,
    label: 'Manage messages',
    hint: "Delete and pin other people's messages.",
  },
  {
    bit: Permission.MENTION_EVERYONE,
    label: 'Mention everyone',
    hint: 'Use @everyone and @here.',
  },
  { bit: Permission.CONNECT, label: 'Connect', hint: 'Join this voice channel.' },
  { bit: Permission.SPEAK, label: 'Speak', hint: 'Transmit audio.' },
  { bit: Permission.VIDEO, label: 'Share screen', hint: 'Start a screen share.' },
];

type TriState = 'inherit' | 'allow' | 'deny';

export function ChannelSettingsModal({
  channelId,
  onClose,
}: {
  channelId: string;
  onClose: () => void;
}) {
  const channel = useAppStore((s) => s.channels[channelId]);
  const rolesForServer = useAppStore((s) => s.rolesForServer);
  const upsertChannel = useAppStore((s) => s.upsertChannel);
  const toast = useUiStore((s) => s.toast);

  const [tab, setTab] = useState<Tab>('overview');
  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [overwrites, setOverwrites] = useState<ChannelOverwrite[]>([]);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [loadingPermissions, setLoadingPermissions] = useState(false);

  const roles = channel?.serverId ? rolesForServer(channel.serverId) : [];

  /* Load the authoritative overwrites when the permissions tab opens. */
  useEffect(() => {
    if (tab !== 'permissions' || !channel) return;

    let cancelled = false;
    setLoadingPermissions(true);

    api
      .get<{ channel: Channel }>(`/api/channels/${channelId}`)
      .then((response) => {
        if (cancelled) return;
        setOverwrites(response.channel.overwrites ?? []);
        setSelectedRoleId((current) => current ?? roles.find((r) => r.isDefault)?.id ?? null);
      })
      .catch(() => {
        if (!cancelled) toast('Could not load channel permissions', 'error');
      })
      .finally(() => {
        if (!cancelled) setLoadingPermissions(false);
      });

    return () => {
      cancelled = true;
    };
    // `roles` is derived and stable enough; re-running on it would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, channelId, channel]);

  if (!channel) return null;

  const saveOverview = async () => {
    setSaving(true);
    setError(null);
    try {
      const response = await api.patch<{ channel: Channel }>(`/api/channels/${channelId}`, {
        name: name.trim(),
        topic: topic.trim() || null,
      });
      upsertChannel(response.channel);
      toast('Channel updated', 'success');
      onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not save those changes');
    } finally {
      setSaving(false);
    }
  };

  const selectedOverwrite = overwrites.find(
    (o) => o.targetType === 'role' && o.targetId === selectedRoleId,
  );

  const stateFor = (bit: number): TriState => {
    if (!selectedOverwrite) return 'inherit';
    if ((selectedOverwrite.allow & bit) !== 0) return 'allow';
    if ((selectedOverwrite.deny & bit) !== 0) return 'deny';
    return 'inherit';
  };

  const setState = async (bit: number, next: TriState) => {
    if (!selectedRoleId) return;

    // Recompute both masks from the current state, then send the whole pair. Sending a
    // delta would require the server to know which bits the client meant to change.
    let allow = selectedOverwrite?.allow ?? 0;
    let deny = selectedOverwrite?.deny ?? 0;

    allow &= ~bit;
    deny &= ~bit;
    if (next === 'allow') allow |= bit;
    if (next === 'deny') deny |= bit;

    const optimistic: ChannelOverwrite = {
      channelId,
      targetType: 'role',
      targetId: selectedRoleId,
      allow,
      deny,
    };

    setOverwrites((current) => [
      ...current.filter((o) => !(o.targetType === 'role' && o.targetId === selectedRoleId)),
      optimistic,
    ]);

    try {
      const response = await api.put<{ channel: Channel }>(
        `/api/channels/${channelId}/permissions`,
        { targetType: 'role', targetId: selectedRoleId, allow, deny },
      );
      setOverwrites(response.channel.overwrites ?? []);
      upsertChannel(response.channel);
    } catch (err) {
      toast(
        err instanceof ApiClientError ? err.message : 'Could not update that permission',
        'error',
      );
      // Roll back by refetching the truth.
      const response = await api.get<{ channel: Channel }>(`/api/channels/${channelId}`);
      setOverwrites(response.channel.overwrites ?? []);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`${channel.type === 'voice' ? '' : '#'}${channel.name}`}
      subtitle="Channel settings"
      width="lg"
      footer={
        tab === 'overview' ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={() => void saveOverview()} loading={saving}>
              Save changes
            </Button>
          </>
        ) : (
          <Button variant="secondary" onClick={onClose}>
            Done
          </Button>
        )
      }
    >
      <nav className="mb-4 flex gap-1 border-b border-line">
        {(['overview', 'permissions'] as Tab[]).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-[14px] capitalize transition-colors',
              tab === key
                ? 'border-accent text-ink'
                : 'border-transparent text-ink-dim hover:text-ink',
            )}
          >
            {key}
          </button>
        ))}
      </nav>

      {tab === 'overview' ? (
        <div className="space-y-4">
          <Field label="Channel name" error={error ?? undefined} required>
            <Input
              value={name}
              maxLength={LIMITS.CHANNEL_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              invalid={Boolean(error)}
            />
          </Field>

          {channel.type === 'text' && (
            <Field label="Topic" hint="Shown next to the channel name in the header.">
              <Textarea
                rows={3}
                value={topic}
                maxLength={LIMITS.CHANNEL_TOPIC_MAX}
                onChange={(event) => setTopic(event.target.value)}
              />
            </Field>
          )}
        </div>
      ) : loadingPermissions ? (
        <div className="flex items-center gap-2 py-8 text-ink-faint">
          <Spinner size={16} /> Loading permissions…
        </div>
      ) : (
        <div className="flex gap-4">
          <div className="w-40 shrink-0">
            <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
              Roles
            </div>
            <ul className="space-y-0.5">
              {roles.map((role) => (
                <li key={role.id}>
                  <button
                    onClick={() => setSelectedRoleId(role.id)}
                    className={clsx(
                      'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                      selectedRoleId === role.id
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
            <p className="mb-3 text-[12px] leading-relaxed text-ink-faint">
              <strong className="text-ink-dim">Inherit</strong> uses the role's server-wide
              permission. <strong className="text-ink-dim">Allow</strong> and{' '}
              <strong className="text-ink-dim">Deny</strong> override it for this channel only.
            </p>

            <ul className="divide-y divide-line">
              {CHANNEL_PERMISSIONS.filter((permission) =>
                channel.type === 'voice'
                  ? true
                  : ![Permission.CONNECT, Permission.SPEAK, Permission.VIDEO].includes(
                      permission.bit,
                    ),
              ).map((permission) => (
                <li key={permission.bit} className="flex items-center gap-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] text-ink">{permission.label}</span>
                    <span className="block text-[12px] text-ink-faint">{permission.hint}</span>
                  </span>
                  <TriToggle
                    value={stateFor(permission.bit)}
                    onChange={(next) => void setState(permission.bit, next)}
                  />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}

function TriToggle({
  value,
  onChange,
}: {
  value: TriState;
  onChange: (next: TriState) => void;
}) {
  const options: { key: TriState; icon: React.ReactNode; label: string; tone: string }[] = [
    { key: 'deny', icon: <X size={14} />, label: 'Deny', tone: 'bg-danger text-white' },
    { key: 'inherit', icon: <Minus size={14} />, label: 'Inherit', tone: 'bg-line-strong text-ink' },
    { key: 'allow', icon: <Check size={14} />, label: 'Allow', tone: 'bg-online text-surface-0' },
  ];

  return (
    <div className="flex shrink-0 overflow-hidden rounded-md border border-line">
      {options.map((option) => (
        <button
          key={option.key}
          title={option.label}
          aria-label={option.label}
          aria-pressed={value === option.key}
          onClick={() => onChange(option.key)}
          className={clsx(
            'flex h-7 w-9 items-center justify-center transition-colors',
            value === option.key ? option.tone : 'bg-surface-3 text-ink-faint hover:text-ink',
          )}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}

export { listPermissions };
