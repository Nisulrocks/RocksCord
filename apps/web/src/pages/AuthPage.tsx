/**
 * Sign in / create account.
 *
 * Validation runs against the same zod schemas the server uses, so the inline errors a
 * user sees while typing are exactly the rules that will be enforced on submit. Server
 * field errors are merged into the same display, so a duplicate email lands on the email
 * field rather than in a generic banner.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AtSign, KeyRound, User as UserIcon } from 'lucide-react';
import { loginSchema, registerSchema } from '@rockscord/shared';
import type { SelfUser } from '@rockscord/shared';
import { ApiClientError } from '../lib/api';
import type { RegisterResult } from '../hooks/useAuth';
import { Button, Field, Input } from '../components/ui/primitives';
import { VerifyEmailNotice } from '../components/auth/VerifyEmailNotice';
import { AuthShell } from '../components/auth/AuthShell';

interface AuthPageProps {
  mode: 'login' | 'register';
  onLogin: (identifier: string, password: string) => Promise<SelfUser>;
  onRegister: (input: {
    email: string;
    username: string;
    password: string;
    displayName?: string;
  }) => Promise<RegisterResult>;
}

/** Set while an account is waiting on a confirmation link, which replaces the form. */
interface PendingVerification {
  email: string;
  /** Distinguishes "you just signed up" from "this old account was never confirmed". */
  fromLogin: boolean;
  /** False when the server could not hand the message to its provider. */
  emailSent: boolean;
}

export function AuthPage({ mode, onLogin, onRegister }: AuthPageProps) {
  const navigate = useNavigate();
  const isRegister = mode === 'register';

  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<PendingVerification | null>(null);

  /**
   * Validate locally first. This is a UX nicety only -- it saves a round trip and gives
   * instant feedback; the server validates the same schema regardless.
   */
  const localErrors = useMemo(() => {
    if (isRegister) {
      const result = registerSchema.safeParse({ email, username, password, displayName: displayName || undefined });
      if (result.success) return {};
      const out: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key = String(issue.path[0] ?? '_');
        out[key] ??= issue.message;
      }
      return out;
    }
    const result = loginSchema.safeParse({ identifier, password });
    if (result.success) return {};
    const out: Record<string, string> = {};
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? '_');
      out[key] ??= issue.message;
    }
    return out;
  }, [isRegister, email, username, password, displayName, identifier]);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);

    // Only surface validation errors on submit, not while the user is still typing.
    if (Object.keys(localErrors).length > 0) {
      setErrors(localErrors);
      return;
    }

    setErrors({});
    setSubmitting(true);

    try {
      if (isRegister) {
        const result = await onRegister({
          email,
          username,
          password,
          displayName: displayName || undefined,
        });

        if (result.status === 'verify-email') {
          // No session was issued, so there is nowhere to navigate to yet.
          setPending({
            email: result.email,
            fromLogin: false,
            emailSent: result.emailSent,
          });
          return;
        }
      } else {
        await onLogin(identifier, password);
      }
      navigate('/friends', { replace: true });
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === 'EMAIL_NOT_VERIFIED') {
          // The password was correct; only the address is unconfirmed. The server echoes
          // it back because the user may have signed in with their username.
          setPending({ email: error.email ?? identifier, fromLogin: true, emailSent: true });
          return;
        }
        if (error.details) {
          const mapped: Record<string, string> = {};
          for (const [field, messages] of Object.entries(error.details)) {
            if (messages[0]) mapped[field] = messages[0];
          }
          setErrors(mapped);
          // A field-level error is already visible next to its input; a banner too would
          // be redundant noise.
          if (Object.keys(mapped).length === 0) setFormError(error.message);
        } else {
          setFormError(error.message);
        }
      } else {
        setFormError('Could not reach the server. Is it running?');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    /* The verification notice brings its own heading, so the shell's is omitted there. */
    <AuthShell
      title={pending ? undefined : isRegister ? 'Create your account' : 'Welcome back'}
      subtitle={
        isRegister
          ? 'Pick a name. You can change how it looks later.'
          : 'Sign in to pick up where you left off.'
      }
    >
      {pending ? (
          <VerifyEmailNotice
            email={pending.email}
            fromLogin={pending.fromLogin}
            emailSent={pending.emailSent}
            onBack={() => {
              setPending(null);
              setPassword('');
              navigate('/login');
            }}
          />
        ) : (
          <>
          <form
            onSubmit={handleSubmit}
            className="rounded-panel border border-line bg-surface-2 p-6 shadow-pop"
            noValidate
          >
            <div className="space-y-4">
              {isRegister ? (
                <>
                  <Field label="Email" error={errors.email} required>
                    <Input
                      type="email"
                      autoComplete="email"
                      placeholder="you@example.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      invalid={Boolean(errors.email)}
                      autoFocus
                    />
                  </Field>

                  <Field
                    label="Username"
                    hint="Letters, numbers, and . _ - . You will get a #tag automatically."
                    error={errors.username}
                    required
                  >
                    <Input
                      autoComplete="username"
                      placeholder="alex"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      invalid={Boolean(errors.username)}
                    />
                  </Field>

                  <Field label="Display name" hint="Optional. Defaults to your username.">
                    <Input
                      placeholder="Alex Rivera"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                    />
                  </Field>

                  <Field label="Password" error={errors.password} required>
                    <Input
                      type="password"
                      autoComplete="new-password"
                      placeholder="At least 8 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      invalid={Boolean(errors.password)}
                    />
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Email or username" error={errors.identifier} required>
                    <Input
                      autoComplete="username"
                      placeholder="you@example.com"
                      value={identifier}
                      onChange={(e) => setIdentifier(e.target.value)}
                      invalid={Boolean(errors.identifier)}
                      autoFocus
                    />
                  </Field>

                  <Field label="Password" error={errors.password} required>
                    <Input
                      type="password"
                      autoComplete="current-password"
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      invalid={Boolean(errors.password)}
                    />
                  </Field>

                  {/*
                    * Under the password box rather than beside the label: it is only ever
                    * wanted after typing one that did not work, so it belongs where the
                    * eye already is at that moment.
                    */}
                  <div className="-mt-1 text-right">
                    <Link
                      to="/forgot-password"
                      className="text-[12.5px] text-ink-dim hover:text-accent-soft hover:underline"
                    >
                      Forgot your password?
                    </Link>
                  </div>
                </>
              )}
            </div>

            {formError && (
              <p className="mt-4 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px] text-danger">
                {formError}
              </p>
            )}

            <Button type="submit" block size="lg" loading={submitting} className="mt-6">
              {isRegister ? 'Create account' : 'Sign in'}
            </Button>

            <p className="mt-4 text-center text-[13px] text-ink-dim">
              {isRegister ? 'Already have an account? ' : 'New here? '}
              <Link
                to={isRegister ? '/login' : '/register'}
                className="font-medium text-accent-soft hover:underline"
              >
                {isRegister ? 'Sign in' : 'Create one'}
              </Link>
            </p>
          </form>

          <p className="mt-5 text-center text-[12px] leading-relaxed text-ink-faint">
            Running the seeded demo? Sign in as{' '}
            <code className="rounded bg-surface-3 px-1.5 py-0.5 text-ink-dim">alex@rockscord.test</code>{' '}
            with <code className="rounded bg-surface-3 px-1.5 py-0.5 text-ink-dim">password123</code>
          </p>
          </>
      )}
    </AuthShell>
  );
}
