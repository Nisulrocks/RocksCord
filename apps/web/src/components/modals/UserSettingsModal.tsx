/**
 * User settings: profile, account security, appearance, and audio.
 *
 * The password form deliberately requires the current password even though the user is
 * already authenticated — an unattended session should not be enough to lock someone out
 * of their own account.
 *
 * Appearance and voice live in `./settings/` and read from `useSettingsStore` rather than
 * the API: they are properties of the device, not the account. Both apply immediately,
 * including to a call already in progress.
 */

import { useRef, useState } from 'react';
import { ImagePlus, LogOut } from 'lucide-react';
import clsx from 'clsx';
import { LIMITS, changePasswordSchema } from '@rockscord/shared';
import type { SelfUser, UserStatus } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { setPresenceStatus } from '../../lib/socket';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { AppearanceTab } from './settings/AppearanceTab';
import { VoiceTab } from './settings/VoiceTab';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { Button, Field, Input, Textarea } from '../ui/primitives';

type Tab = 'profile' | 'account' | 'appearance' | 'voice';

const STATUS_OPTIONS: { value: UserStatus; label: string; description: string; dot: string }[] = [
  { value: 'online', label: 'Online', description: 'Available to chat.', dot: 'bg-online' },
  { value: 'idle', label: 'Idle', description: 'Around, but not at the keyboard.', dot: 'bg-idle' },
  { value: 'dnd', label: 'Do not disturb', description: 'Suppresses notifications.', dot: 'bg-dnd' },
  { value: 'offline', label: 'Invisible', description: 'Appear offline to everyone.', dot: 'bg-offline' },
];

export function UserSettingsModal({
  initialTab = 'profile',
  onClose,
}: {
  initialTab?: Tab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const user = useAppStore((s) => s.user);

  if (!user) return null;

  const tabs: Tab[] = ['profile', 'account', 'appearance', 'voice'];

  return (
    <Modal open onClose={onClose} title="Settings" width="lg">
      <nav className="mb-4 flex gap-1 border-b border-line">
        {tabs.map((key) => (
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

      {tab === 'profile' && <ProfileTab user={user} />}
      {tab === 'account' && <AccountTab user={user} />}
      {tab === 'appearance' && <AppearanceTab />}
      {tab === 'voice' && <VoiceTab />}
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

function ProfileTab({ user }: { user: SelfUser }) {
  const setUser = useAppStore((s) => s.setUser);
  const presence = useAppStore((s) => s.presence[user.id]);
  const toast = useUiStore((s) => s.toast);

  const fileRef = useRef<HTMLInputElement>(null);
  const [displayName, setDisplayName] = useState(user.displayName);
  const [bio, setBio] = useState(user.bio ?? '');
  const [customStatus, setCustomStatus] = useState(presence?.customStatus ?? '');
  const [status, setStatus] = useState<UserStatus>(presence?.status ?? 'online');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const response = await api.patch<{ user: SelfUser }>('/api/users/@me', {
        displayName: displayName.trim(),
        bio: bio.trim() || null,
        customStatus: customStatus.trim() || null,
        status,
      });
      setUser(response.user);
      setPresenceStatus(status, customStatus.trim() || null);
      toast('Profile updated', 'success');
    } catch (error) {
      toast(error instanceof ApiClientError ? error.message : 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  };

  const uploadAvatar = async (file: File | undefined) => {
    if (!file) return;
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await api.upload<{ avatarUrl: string }>('/api/files/avatar', formData);
      setUser({ ...user, avatarUrl: response.avatarUrl });
      toast('Avatar updated', 'success');
    } catch (error) {
      toast(error instanceof ApiClientError ? error.message : 'Avatar upload failed', 'error');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4">
        <button
          onClick={() => fileRef.current?.click()}
          className="group relative overflow-hidden rounded-full"
        >
          <Avatar userId={user.id} name={user.displayName} src={user.avatarUrl} size={80} />
          <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
            <ImagePlus size={22} className="text-white" />
          </span>
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => void uploadAvatar(event.target.files?.[0])}
        />
        <div>
          <div className="text-[15px] font-semibold text-ink">
            {user.username}
            <span className="text-ink-faint">#{user.discriminator}</span>
          </div>
          <div className="text-[13px] text-ink-faint">
            Your tag is permanent — it is what makes your username unique.
          </div>
        </div>
      </div>

      <Field label="Display name" hint="How your name appears to everyone else.">
        <Input
          value={displayName}
          maxLength={LIMITS.DISPLAY_NAME_MAX}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </Field>

      <Field label="Custom status" hint="A short line shown next to your name.">
        <Input
          value={customStatus}
          maxLength={LIMITS.CUSTOM_STATUS_MAX}
          onChange={(event) => setCustomStatus(event.target.value)}
          placeholder="debugging WebRTC"
        />
      </Field>

      <Field label="About me">
        <Textarea
          rows={3}
          value={bio}
          maxLength={LIMITS.BIO_MAX}
          onChange={(event) => setBio(event.target.value)}
          placeholder="A sentence or two about you."
        />
      </Field>

      <div>
        <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-dim">
          Status
        </span>
        <div className="grid grid-cols-2 gap-2">
          {STATUS_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setStatus(option.value)}
              className={clsx(
                'flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                status === option.value
                  ? 'border-accent bg-accent-wash'
                  : 'border-line bg-surface-3 hover:border-line-strong',
              )}
            >
              <span className={clsx('h-3 w-3 shrink-0 rounded-full', option.dot)} />
              <span className="min-w-0">
                <span className="block text-[14px] text-ink">{option.label}</span>
                <span className="block truncate text-[11px] text-ink-faint">
                  {option.description}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <Button onClick={() => void save()} loading={saving}>
        Save profile
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function AccountTab({ user }: { user: SelfUser }) {
  const toast = useUiStore((s) => s.toast);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (next !== confirm) {
      setError('The new passwords do not match');
      return;
    }

    const parsed = changePasswordSchema.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the password');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await api.patch('/api/auth/password', parsed.data);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast('Password changed. Other sessions were signed out.', 'success');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not change your password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-lg border border-line bg-surface-3 p-4">
        <div className="text-[11px] font-bold uppercase tracking-wider text-ink-faint">Email</div>
        <div className="mt-0.5 text-[15px] text-ink">{user.email}</div>
      </div>

      <div>
        <h4 className="mb-1 text-[15px] font-semibold text-ink">Change password</h4>
        <p className="mb-3 text-[13px] text-ink-dim">
          Changing your password signs out every other device. This one stays signed in.
        </p>

        <div className="space-y-3">
          <Field label="Current password" required>
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
          </Field>
          <Field label="New password" error={error ?? undefined} required>
            <Input
              type="password"
              autoComplete="new-password"
              value={next}
              onChange={(event) => setNext(event.target.value)}
              invalid={Boolean(error)}
            />
          </Field>
          <Field label="Confirm new password" required>
            <Input
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
          </Field>
        </div>

        <Button
          className="mt-4"
          onClick={() => void submit()}
          loading={busy}
          disabled={!current || !next || !confirm}
        >
          Change password
        </Button>
      </div>

      <div className="border-t border-line pt-4">
        <Button
          variant="secondary"
          onClick={async () => {
            await api.post('/api/auth/logout-all');
            toast('Signed out everywhere. Reloading…', 'success');
            window.setTimeout(() => window.location.reload(), 800);
          }}
        >
          <LogOut size={14} />
          Sign out of all devices
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
