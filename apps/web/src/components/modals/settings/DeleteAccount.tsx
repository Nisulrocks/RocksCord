/**
 * Delete account.
 *
 * Two things this is careful about, because deletion has no undo.
 *
 * It re-authenticates. An unattended session should not be enough to destroy an account,
 * and the password field is the pause that makes the decision deliberate.
 *
 * And it is honest about what survives. Messages are *not* removed: they are reattributed
 * to "Deleted User", because deleting them would tear holes in other people's
 * conversations and orphan every reply. Saying so up front is better than a vague
 * "this cannot be undone" that leaves people to discover the difference afterwards.
 */

import { useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { api, ApiClientError } from '../../../lib/api';
import { Button, Field, Input } from '../../ui/primitives';

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  /** Servers that must be dealt with first, named by the server so the fix is obvious. */
  const [blockingServers, setBlockingServers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    setBlockingServers([]);
    try {
      await api.delete('/api/users/@me', { body: { password } });
      // A full reload rather than a routed sign-out: every store in memory belongs to an
      // account that no longer exists.
      window.location.href = '/login';
    } catch (caught) {
      if (caught instanceof ApiClientError) {
        const servers = caught.details?.servers;
        if (servers?.length) setBlockingServers(servers);
        setError(caught.message);
      } else {
        setError('Could not reach the server.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="border-t border-line pt-4">
        <h4 className="text-[14px] font-semibold text-ink">Delete account</h4>
        <p className="mt-1 text-[13px] text-ink-dim">
          Permanently closes your account. This cannot be undone.
        </p>
        <Button variant="danger" className="mt-3" onClick={() => setOpen(true)}>
          <TriangleAlert size={14} aria-hidden />
          Delete my account
        </Button>
      </div>
    );
  }

  return (
    <div className="border-t border-line pt-4">
      <div className="rounded-lg border border-danger/40 bg-danger/10 p-4">
        <h4 className="flex items-center gap-2 text-[14px] font-semibold text-danger">
          <TriangleAlert size={15} aria-hidden />
          Delete your account
        </h4>

        <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
          Your profile, friendships, and server memberships are removed, and you are signed
          out everywhere. Servers you own that nobody else has joined are deleted too.
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
          Messages you have already sent stay where they are, shown as{' '}
          <span className="text-ink">Deleted User</span>. Removing them would leave holes in
          other people&rsquo;s conversations and break every reply to them.
        </p>
        <p className="mt-2 text-[13px] font-medium text-ink">This cannot be undone.</p>

        {blockingServers.length > 0 && (
          <div className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[13px] text-warning">
            <p className="font-medium">Deal with these servers first:</p>
            <ul className="mt-1 list-inside list-disc">
              {blockingServers.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
            <p className="mt-1.5 leading-relaxed">
              Other people are in them, so deleting your account would take their history
              with it. Transfer ownership, or delete the server deliberately.
            </p>
          </div>
        )}

        <div className="mt-4">
          <Field
            label="Confirm your password"
            error={blockingServers.length === 0 ? (error ?? undefined) : undefined}
          >
            <Input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              invalid={Boolean(error) && blockingServers.length === 0}
            />
          </Field>
        </div>

        <div className="mt-4 flex gap-2">
          <Button
            variant="danger"
            loading={busy}
            disabled={!password}
            onClick={() => void submit()}
          >
            Delete permanently
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setOpen(false);
              setPassword('');
              setError(null);
              setBlockingServers([]);
            }}
          >
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
