/**
 * Step two of a reset: choose the new password.
 *
 * Reached only from a link, so the token arrives in the query string. It is read once
 * into state rather than off the URL at submit time -- the address bar is a place things
 * get edited, shared, and cleaned by extensions, and the form should keep working if it
 * changes underneath.
 *
 * A missing token is treated as a broken link and says so immediately, rather than
 * letting someone type a password twice and only then be told it could not be used.
 */

import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, ShieldAlert } from 'lucide-react';
import { resetPasswordSchema } from '@rockscord/shared';
import { api, ApiClientError } from '../lib/api';
import { AuthShell } from '../components/auth/AuthShell';
import { Button, Field, Input } from '../components/ui/primitives';

/** Which box an error belongs to, so the message and the highlight agree. */
type ResetField = 'password' | 'confirm' | 'form';

export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();

  // Read once, at mount: see the note above on not trusting the URL to hold still.
  const [token] = useState(() => params.get('token') ?? '');

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<{ field: ResetField; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const errorFor = (field: ResetField) =>
    error?.field === field ? error.message : undefined;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();

    if (password !== confirm) {
      setError({ field: 'confirm', message: 'The passwords do not match' });
      return;
    }

    const parsed = resetPasswordSchema.safeParse({ token, newPassword: password });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setError({
        field: issue?.path[0] === 'token' ? 'form' : 'password',
        message: issue?.message ?? 'Check the password',
      });
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.post('/api/auth/reset-password', parsed.data);
      setDone(true);
    } catch (err) {
      setError({
        field: 'form',
        message:
          err instanceof ApiClientError ? err.message : 'Could not change your password.',
      });
    } finally {
      setSubmitting(false);
    }
  };

  /* ---------------------------------------------------------------------- */

  if (!token) {
    return (
      <AuthShell>
        <div className="rounded-panel border border-line bg-surface-2 p-6 text-center shadow-pop">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-danger/10">
            <ShieldAlert size={22} className="text-danger" aria-hidden />
          </div>
          <h1 className="mt-4 text-[19px] font-semibold text-ink">This link is incomplete</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-dim">
            It is missing the part that identifies your account. Mail clients sometimes cut
            long links in half &mdash; try copying the whole thing, or ask for a new one.
          </p>
          <Link
            to="/forgot-password"
            className="mt-5 inline-block text-[13px] font-medium text-accent-soft hover:underline"
          >
            Send a new link
          </Link>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <div className="rounded-panel border border-line bg-surface-2 p-6 text-center shadow-pop">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-wash">
            <CheckCircle2 size={22} className="text-accent-soft" aria-hidden />
          </div>
          <h1 className="mt-4 text-[19px] font-semibold text-ink">Password changed</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-dim">
            Every device that was signed in has been signed out, including any you did not
            recognise. Sign in again with your new password.
          </p>
          <Button className="mt-5" block size="lg" onClick={() => navigate('/login')}>
            Sign in
          </Button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Then sign in with it.">
      <form
        onSubmit={handleSubmit}
        className="rounded-panel border border-line bg-surface-2 p-6 shadow-pop"
        noValidate
      >
        <div className="space-y-4">
          <Field label="New password" error={errorFor('password')} required>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="At least 8 characters"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              invalid={Boolean(errorFor('password'))}
              autoFocus
            />
          </Field>

          <Field label="Confirm new password" error={errorFor('confirm')} required>
            <Input
              type="password"
              autoComplete="new-password"
              placeholder="••••••••"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              invalid={Boolean(errorFor('confirm'))}
            />
          </Field>
        </div>

        {errorFor('form') && (
          <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {errorFor('form')}{' '}
            <Link to="/forgot-password" className="font-medium underline">
              Send a new link
            </Link>
          </p>
        )}

        <Button type="submit" block size="lg" loading={submitting} className="mt-5">
          Change password
        </Button>

        <p className="mt-4 text-center text-[13px] text-ink-dim">
          <Link to="/login" className="font-medium text-accent-soft hover:underline">
            Back to sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
