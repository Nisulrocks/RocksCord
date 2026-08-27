/**
 * The screen shown once an account exists but its address has not been confirmed.
 *
 * Reached from two directions — finishing registration, and trying to sign in to an
 * account that never confirmed — so it lives apart from the form rather than inside it.
 *
 * The resend cooldown is enforced here as well as on the server. The server's version is
 * the one that matters, but it answers identically whether it sent anything or not (so
 * that the endpoint cannot be used to test which addresses exist), which leaves the client
 * unable to tell a real send from a suppressed one. Counting down locally is what makes
 * the button honest about when pressing it will actually do something.
 */

import { useCallback, useEffect, useState } from 'react';
import { MailCheck, MailWarning, RotateCw } from 'lucide-react';
import { api, ApiClientError } from '../../lib/api';
import { Button } from '../ui/primitives';

const COOLDOWN_SECONDS = 60;

interface VerifyEmailNoticeProps {
  email: string;
  /** Return to the sign-in form. */
  onBack: () => void;
  /** True when arriving from a failed sign-in rather than from registering. */
  fromLogin?: boolean;
  /**
   * False when the server could not hand the message to its email provider.
   *
   * Worth saying out loud: without it this screen sends someone hunting through a spam
   * folder for a message that was never accepted in the first place.
   */
  emailSent?: boolean;
}

export function VerifyEmailNotice({
  email,
  onBack,
  fromLogin = false,
  emailSent = true,
}: VerifyEmailNoticeProps) {
  // Registration has just sent one, so the button starts on cooldown in that case --
  // unless the send failed, where making someone wait to retry would be perverse.
  const [cooldown, setCooldown] = useState(fromLogin || !emailSent ? 0 : COOLDOWN_SECONDS);
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [cooldown]);

  const resend = useCallback(async () => {
    setSending(true);
    setError(null);
    setNotice(null);
    try {
      await api.post('/api/auth/resend-verification', { email }, { skipRefresh: true });
      setNotice('Sent. It usually arrives within a minute.');
      setCooldown(COOLDOWN_SECONDS);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.message
          : 'Could not reach the server. Check your connection and try again.',
      );
    } finally {
      setSending(false);
    }
  }, [email]);

  return (
    <div className="rounded-panel border border-line bg-surface-2 p-6 shadow-pop">
      <div className="flex flex-col items-center text-center">
        <div
          className={
            emailSent
              ? 'mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent/15 text-accent-soft'
              : 'mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-warning/15 text-warning'
          }
        >
          {emailSent ? <MailCheck size={24} aria-hidden /> : <MailWarning size={24} aria-hidden />}
        </div>

        <h2 className="text-lg font-semibold text-ink">
          {!emailSent
            ? 'We could not send that email'
            : fromLogin
              ? 'Confirm your email to continue'
              : 'Check your inbox'}
        </h2>

        <p className="mt-2 text-sm leading-relaxed text-ink-dim">
          {!emailSent
            ? 'Your account was created, but the confirmation link could not be sent to'
            : fromLogin
              ? 'This account still needs its email address confirmed. We sent a link to'
              : 'Your account is created. Click the link we sent to'}{' '}
          {/* break-all: a long address must not push the panel wider than the viewport. */}
          <span className="break-all font-medium text-ink">{email}</span>
          {!emailSent ? '.' : fromLogin ? ' — open it, then sign in.' : ' to finish signing in.'}
        </p>

        {emailSent ? (
          <p className="mt-4 rounded-lg border border-line bg-surface-1 px-3 py-2 text-[12.5px] leading-relaxed text-ink-faint">
            Nothing after a minute or two? Check your spam or junk folder — a first message
            from a new sender often lands there.
          </p>
        ) : (
          <p className="mt-4 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px] leading-relaxed text-warning">
            The server could not send that email just now, so nothing is on its way yet.
            Your account was still created — try again below, and tell whoever runs this
            server if it keeps failing.
          </p>
        )}

        {notice && (
          <p className="mt-4 w-full rounded-lg border border-accent/40 bg-accent/10 px-3 py-2 text-[13px] text-accent-soft">
            {notice}
          </p>
        )}

        {error && (
          <p className="mt-4 w-full rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
            {error}
          </p>
        )}

        <Button
          type="button"
          variant="secondary"
          block
          className="mt-5"
          loading={sending}
          disabled={cooldown > 0}
          onClick={resend}
        >
          <RotateCw size={16} aria-hidden />
          {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend the link'}
        </Button>

        <button
          type="button"
          onClick={onBack}
          className="mt-4 text-[13px] font-medium text-accent-soft hover:underline"
        >
          Back to sign in
        </button>
      </div>
    </div>
  );
}
