/**
 * Step one of a reset: ask for the link.
 *
 * The confirmation deliberately does not say whether an account was found. The server
 * answers identically either way -- otherwise this page becomes a way to test whether
 * someone has an account here -- and a screen that said "no account with that address"
 * would leak exactly what the API refuses to.
 *
 * That makes the wording matter more than usual. "If an account uses that address" is
 * doing real work: it has to be honest that nothing may have been sent, without making
 * someone who typed their own address correctly doubt that it worked.
 */

import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { forgotPasswordSchema } from '@rockscord/shared';
import { api, ApiClientError } from '../lib/api';
import { AuthShell } from '../components/auth/AuthShell';
import { Button, Field, Input } from '../components/ui/primitives';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setFormError(null);

    const parsed = forgotPasswordSchema.safeParse({ email });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a valid email address');
      return;
    }

    setSubmitting(true);
    try {
      await api.post('/api/auth/forgot-password', parsed.data);
      setSent(true);
    } catch (err) {
      /*
       * Only transport-level failures reach here -- the route itself answers 200 whether
       * or not the address is known. A rate limit is the realistic case, and it is worth
       * showing, because the alternative is a button that silently does nothing.
       */
      setFormError(
        err instanceof ApiClientError ? err.message : 'Could not send the reset link. Try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (sent) {
    return (
      <AuthShell>
        <div className="rounded-panel border border-line bg-surface-2 p-6 text-center shadow-pop">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent-wash">
            <MailCheck size={22} className="text-accent-soft" aria-hidden />
          </div>

          <h1 className="mt-4 text-[19px] font-semibold text-ink">Check your inbox</h1>
          <p className="mt-2 text-[13.5px] leading-relaxed text-ink-dim">
            If an account uses <span className="text-ink">{email}</span>, a link to choose a
            new password is on its way. It expires in an hour.
          </p>
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-faint">
            Nothing after a few minutes? Check the spam folder, then make sure that is the
            address you signed up with.
          </p>

          <Link
            to="/login"
            className="mt-5 inline-block text-[13px] font-medium text-accent-soft hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="We will email you a link to choose a new one."
    >
      <form
        onSubmit={handleSubmit}
        className="rounded-panel border border-line bg-surface-2 p-6 shadow-pop"
        noValidate
      >
        <Field label="Email" error={error ?? undefined} required>
          <Input
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            invalid={Boolean(error)}
            autoFocus
          />
        </Field>

        {formError && (
          <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {formError}
          </p>
        )}

        <Button type="submit" block size="lg" loading={submitting} className="mt-5">
          Send reset link
        </Button>

        <p className="mt-4 text-center text-[13px] text-ink-dim">
          Remembered it?{' '}
          <Link to="/login" className="font-medium text-accent-soft hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
