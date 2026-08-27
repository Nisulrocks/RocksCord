/**
 * Generate and share an invite link.
 *
 * An invite is created as soon as the dialog opens so there is always something to copy —
 * needing to click "generate" before you can share is a pointless extra step.
 */

import { useEffect, useState } from 'react';
import { Check, Copy, RefreshCw } from 'lucide-react';
import type { Invite } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { Modal } from '../ui/Modal';
import { Button, Field, Spinner } from '../ui/primitives';

const EXPIRY_OPTIONS = [
  { label: '30 minutes', value: 30 * 60 },
  { label: '6 hours', value: 6 * 60 * 60 },
  { label: '1 day', value: 24 * 60 * 60 },
  { label: '7 days', value: 7 * 24 * 60 * 60 },
  { label: 'Never', value: null },
] as const;

const USE_OPTIONS = [
  { label: 'No limit', value: null },
  { label: '1 use', value: 1 },
  { label: '5 uses', value: 5 },
  { label: '25 uses', value: 25 },
] as const;

export function InviteModal({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const server = useAppStore((s) => s.servers[serverId]);
  const toast = useUiStore((s) => s.toast);

  const [invite, setInvite] = useState<Invite | null>(null);
  const [expiresIn, setExpiresIn] = useState<number | null>(7 * 24 * 60 * 60);
  const [maxUses, setMaxUses] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async (options?: { expiresIn: number | null; maxUses: number | null }) => {
    setBusy(true);
    setError(null);
    try {
      const response = await api.post<{ invite: Invite }>(`/api/invites/server/${serverId}`, {
        expiresIn: options ? options.expiresIn : expiresIn,
        maxUses: options ? options.maxUses : maxUses,
      });
      setInvite(response.invite);
      setCopied(false);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create an invite');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    void create();
    // Only on open; regenerating happens through explicit actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const link = invite ? `${window.location.origin}/invite/${invite.code}` : '';

  const copy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      toast('Invite link copied', 'success');
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Clipboard access can be denied; the input is selectable as a fallback.
      toast('Could not copy automatically — select the link and copy it', 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={`Invite people to ${server?.name ?? 'this server'}`}
      subtitle="Share this link to give someone access."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        <Field label="Invite link" error={error ?? undefined}>
          <div className="flex gap-2">
            <input
              readOnly
              value={busy && !invite ? 'Generating…' : link}
              onFocus={(event) => event.target.select()}
              className="w-full rounded-lg border border-line bg-surface-0 px-3 py-2.5 font-mono text-[13px] text-ink outline-none focus:border-accent"
            />
            <Button onClick={() => void copy()} disabled={!link} className="shrink-0">
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Expires after">
            <select
              value={String(expiresIn)}
              onChange={(event) => {
                const value = event.target.value === 'null' ? null : Number(event.target.value);
                setExpiresIn(value);
                void create({ expiresIn: value, maxUses });
              }}
              className="w-full rounded-lg border border-line bg-surface-0 px-3 py-2.5 text-[14px] text-ink outline-none focus:border-accent"
            >
              {EXPIRY_OPTIONS.map((option) => (
                <option key={option.label} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Max uses">
            <select
              value={String(maxUses)}
              onChange={(event) => {
                const value = event.target.value === 'null' ? null : Number(event.target.value);
                setMaxUses(value);
                void create({ expiresIn, maxUses: value });
              }}
              className="w-full rounded-lg border border-line bg-surface-0 px-3 py-2.5 text-[14px] text-ink outline-none focus:border-accent"
            >
              {USE_OPTIONS.map((option) => (
                <option key={option.label} value={String(option.value)}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface-3 px-3 py-2.5">
          <div className="min-w-0 text-[12px] text-ink-faint">
            {busy ? (
              <span className="flex items-center gap-1.5">
                <Spinner size={12} /> Updating invite…
              </span>
            ) : invite ? (
              <>
                Code <code className="text-accent-soft">{invite.code}</code> ·{' '}
                {invite.expiresAt
                  ? `expires ${new Date(invite.expiresAt).toLocaleString()}`
                  : 'never expires'}
              </>
            ) : (
              'No invite yet'
            )}
          </div>
          <Button size="sm" variant="ghost" onClick={() => void create()} disabled={busy}>
            <RefreshCw size={13} />
            New link
          </Button>
        </div>

        <p className="text-[12px] leading-relaxed text-ink-faint">
          Testing locally with a second device? Replace{' '}
          <code className="rounded bg-surface-3 px-1">localhost</code> in the link with this
          machine's LAN IP address so the other device can reach it.
        </p>
      </div>
    </Modal>
  );
}
