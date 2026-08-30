/**
 * Invite landing page: `/invite/:code`.
 *
 * Works whether or not you are signed in. Signed out, it shows the server preview and
 * sends you to sign in with the code remembered, so accepting the invite is the first
 * thing that happens after you log in — rather than dumping you on the home screen and
 * making you find the link again.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import type { Invite, Server, ServerBundle } from '@rockscord/shared';
import { api, ApiClientError } from '../lib/api';
import { isDesktop } from '../lib/desktop';
import { useAppStore } from '../store/useAppStore';
import { ServerAvatar } from '../components/ui/Avatar';
import { Button, Spinner } from '../components/ui/primitives';

/** Survives the redirect through the login screen. */
const PENDING_INVITE_KEY = 'rockscord:pending-invite';

export function InvitePage({ signedIn }: { signedIn: boolean }) {
  const { code } = useParams<{ code: string }>();
  const navigate = useNavigate();
  // Read once: it cannot change while the page is mounted.
  const [inDesktopApp] = useState(() => isDesktop());
  const applyServerBundle = useAppStore((s) => s.applyServerBundle);

  const [invite, setInvite] = useState<Invite | null>(null);
  const [alreadyMember, setAlreadyMember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    if (!code) return;
    let cancelled = false;

    api
      .get<{ invite: Invite; alreadyMember: boolean }>(`/api/invites/${code}`)
      .then((response) => {
        if (cancelled) return;
        setInvite(response.invite);
        setAlreadyMember(response.alreadyMember);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ApiClientError ? err.message : 'That invite is not valid');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [code]);

  /**
   * Already in this server: open it, do not ask.
   *
   * An invite is a way in, and someone who is already inside has nothing to accept. The
   * page used to show them the full landing card with a button, which reads as being asked
   * to join a server they are looking at in their own sidebar.
   */
  useEffect(() => {
    if (!signedIn || !alreadyMember || !invite) return;
    navigate(`/channels/${invite.serverId}`, { replace: true });
  }, [signedIn, alreadyMember, invite, navigate]);

  /** Signed in and arriving with a stored code: accept it automatically. */
  useEffect(() => {
    if (!signedIn) return;
    const pending = sessionStorage.getItem(PENDING_INVITE_KEY);
    if (pending && pending === code) {
      sessionStorage.removeItem(PENDING_INVITE_KEY);
      void join();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedIn, code]);

  const join = async () => {
    if (!code) return;

    if (!signedIn) {
      // Remember where we were headed, then send them through the login flow.
      sessionStorage.setItem(PENDING_INVITE_KEY, code);
      navigate('/login');
      return;
    }

    setJoining(true);
    try {
      const response = await api.post<ServerBundle & { alreadyMember: boolean }>(
        `/api/invites/${code}`,
      );
      // Channels, roles, and membership together: without them the client cannot resolve
      // permissions for the server it is about to open, and renders it empty.
      applyServerBundle(response);
      navigate(`/channels/${response.server.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not join that server');
    } finally {
      setJoining(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center bg-surface-1 px-4">
      <div className="w-full max-w-sm rounded-panel border border-line bg-surface-2 p-7 text-center shadow-pop">
        {loading ? (
          <div className="flex flex-col items-center gap-3 py-6 text-ink-faint">
            <Spinner size={24} />
            <span className="text-sm">Checking invite…</span>
          </div>
        ) : error ? (
          <>
            <h1 className="text-xl font-semibold text-ink">Invite unavailable</h1>
            <p className="mt-2 text-[14px] text-ink-dim">{error}</p>
            <Button
              variant="secondary"
              block
              className="mt-5"
              onClick={() => navigate(signedIn ? '/friends' : '/login')}
            >
              {signedIn ? 'Back to RocksCord' : 'Go to sign in'}
            </Button>
          </>
        ) : invite?.server ? (
          <>
            <div className="mb-4 flex justify-center">
              <ServerAvatar
                serverId={invite.server.id}
                name={invite.server.name}
                src={invite.server.iconUrl}
                size={80}
                active
              />
            </div>

            <p className="text-[13px] uppercase tracking-wide text-ink-faint">
              You have been invited to join
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-ink">{invite.server.name}</h1>

            {invite.server.description && (
              <p className="mt-2 text-[14px] leading-relaxed text-ink-dim">
                {invite.server.description}
              </p>
            )}

            <div className="mt-3 flex items-center justify-center gap-1.5 text-[13px] text-ink-faint">
              <Users size={14} />
              {invite.server.memberCount}{' '}
              {invite.server.memberCount === 1 ? 'member' : 'members'}
            </div>

            <Button
              block
              size="lg"
              className="mt-6"
              loading={joining}
              onClick={() => void join()}
            >
              {!signedIn
                ? 'Sign in to accept'
                : alreadyMember
                  ? 'Open server'
                  : 'Accept invite'}
            </Button>

            {!signedIn && (
              <p className="mt-3 text-[12px] text-ink-faint">
                You will come straight back here after signing in.
              </p>
            )}

            {/*
              * The way an invite reaches the installed app.
              *
              * A shared link is an ordinary https URL, so the OS hands it to the browser
              * and someone with the desktop app running still joins in a web page. Only
              * a browser can claim an https domain, so the app registers `rockscord://`
              * and this is what uses it.
              *
              * Hidden inside the app itself, where the page is already where the button
              * would send it. Nothing detects whether the app is installed -- there is no
              * reliable way to -- so it stays a suggestion rather than a redirect: on a
              * machine without it, clicking does nothing and the web page is still there.
              */}
            {!inDesktopApp && code && (
              <button
                type="button"
                onClick={() => {
                  window.location.href = `rockscord://invite/${encodeURIComponent(code)}`;
                }}
                className="mt-4 text-[12.5px] text-ink-dim underline-offset-2 hover:text-accent-soft hover:underline"
              >
                Open in the desktop app instead
              </button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export { PENDING_INVITE_KEY };
