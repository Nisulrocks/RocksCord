/**
 * Join a server from an invite code or link.
 *
 * Accepts either a bare code or a full URL, because people paste whatever they were
 * given. A preview is fetched as soon as a plausible code is entered, so you can see what
 * you are joining before committing.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users } from 'lucide-react';
import type { Invite, Server } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { Modal } from '../ui/Modal';
import { ServerAvatar } from '../ui/Avatar';
import { Button, Field, Input, Spinner } from '../ui/primitives';

/** Pull the code out of `https://host/invite/abc123`, or accept a bare code. */
export function extractInviteCode(input: string): string {
  const trimmed = input.trim();
  const match = /(?:invite\/)([A-Za-z0-9]+)/.exec(trimmed);
  if (match?.[1]) return match[1];
  return trimmed.replace(/^\/+|\/+$/g, '');
}

export function JoinServerModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const upsertServer = useAppStore((s) => s.upsertServer);
  const toast = useUiStore((s) => s.toast);

  const [value, setValue] = useState('');
  const [preview, setPreview] = useState<Invite | null>(null);
  const [alreadyMember, setAlreadyMember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState(false);

  const code = extractInviteCode(value);

  /* Debounced preview ---------------------------------------------------- */

  useEffect(() => {
    if (code.length < 4) {
      setPreview(null);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);

    // Debounced so typing a code does not fire a request per keystroke.
    const timer = window.setTimeout(async () => {
      try {
        const response = await api.get<{ invite: Invite; alreadyMember: boolean }>(
          `/api/invites/${code}`,
        );
        if (cancelled) return;
        setPreview(response.invite);
        setAlreadyMember(response.alreadyMember);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setPreview(null);
        setError(err instanceof ApiClientError ? err.message : 'That invite is not valid');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 350);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [code]);

  const join = async () => {
    if (!code) return;
    setJoining(true);
    try {
      const response = await api.post<{ server: Server; alreadyMember: boolean }>(
        `/api/invites/${code}`,
      );
      upsertServer(response.server);
      toast(
        response.alreadyMember
          ? `You are already in ${response.server.name}`
          : `Joined ${response.server.name}`,
        'success',
      );
      onClose();
      navigate(`/channels/${response.server.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not join that server');
    } finally {
      setJoining(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Join a server"
      subtitle="Paste an invite link or code below."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void join()}
            loading={joining}
            disabled={!preview || Boolean(error)}
          >
            {alreadyMember ? 'Open server' : 'Join server'}
          </Button>
        </>
      }
    >
      <Field
        label="Invite link"
        error={error ?? undefined}
        hint="Looks like http://localhost:4000/invite/aB3xY7qP — or just aB3xY7qP"
      >
        <Input
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && preview) void join();
          }}
          placeholder="Enter an invite"
          invalid={Boolean(error)}
        />
      </Field>

      <div className="mt-4 min-h-[76px]">
        {loading && (
          <div className="flex items-center gap-2 text-[13px] text-ink-faint">
            <Spinner size={15} /> Checking invite…
          </div>
        )}

        {preview?.server && !loading && (
          <div className="animate-fade-in flex items-center gap-3 rounded-lg border border-line bg-surface-3 p-3">
            <ServerAvatar
              serverId={preview.server.id}
              name={preview.server.name}
              src={preview.server.iconUrl}
              size={48}
              active
            />
            <div className="min-w-0">
              <div className="truncate text-[15px] font-semibold text-ink">
                {preview.server.name}
              </div>
              {preview.server.description && (
                <div className="truncate text-[13px] text-ink-dim">
                  {preview.server.description}
                </div>
              )}
              <div className="mt-0.5 flex items-center gap-1 text-[12px] text-ink-faint">
                <Users size={12} />
                {preview.server.memberCount}{' '}
                {preview.server.memberCount === 1 ? 'member' : 'members'}
                {alreadyMember && <span className="ml-1 text-online">· you are a member</span>}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
