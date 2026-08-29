/**
 * Create a server, optionally with an icon.
 *
 * The icon uploads *after* the server exists, because the upload endpoint needs a server
 * id to check MANAGE_SERVER against. A failed icon upload therefore never blocks
 * creation — you get the server, and a toast telling you the icon did not stick.
 */

import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ImagePlus } from 'lucide-react';
import { LIMITS, createServerSchema } from '@rockscord/shared';
import type { Server, ServerBundle } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { Modal } from '../ui/Modal';
import { Button, Field, Input, Textarea } from '../ui/primitives';

export function CreateServerModal({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const upsertServer = useAppStore((s) => s.upsertServer);
  const applyServerBundle = useAppStore((s) => s.applyServerBundle);
  const toast = useUiStore((s) => s.toast);

  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pickIcon = (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      toast('The icon needs to be an image', 'error');
      return;
    }
    if (iconPreview) URL.revokeObjectURL(iconPreview);
    setIconFile(file);
    setIconPreview(URL.createObjectURL(file));
  };

  const submit = async () => {
    const parsed = createServerSchema.safeParse({ name, description: description || null });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the server name');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await api.post<ServerBundle>('/api/servers', {
        name: parsed.data.name,
        description: parsed.data.description,
      });
      // Channels, roles, and membership together -- see `applyServerBundle`. Storing only
      // the server left the client navigating into one it could not resolve permissions
      // for, which read as the new server failing to render until a reload.
      applyServerBundle(response);

      if (iconFile) {
        try {
          const formData = new FormData();
          formData.append('file', iconFile);
          const iconResponse = await api.upload<{ iconUrl: string }>(
            `/api/files/icon/${response.server.id}`,
            formData,
          );
          upsertServer({ ...response.server, iconUrl: iconResponse.iconUrl });
        } catch {
          toast('Server created, but the icon could not be uploaded', 'error');
        }
      }

      onClose();
      navigate(`/channels/${response.server.id}`);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create that server');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Create a server"
      subtitle="Your server is where you and your people hang out. Make it yours."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!name.trim()}>
            Create server
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex justify-center">
          <button
            onClick={() => fileRef.current?.click()}
            className="group relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-full border-2 border-dashed border-line-strong text-ink-faint transition-colors hover:border-accent hover:text-accent-soft"
          >
            {iconPreview ? (
              <img src={iconPreview} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="flex flex-col items-center gap-1">
                <ImagePlus size={22} />
                <span className="text-[10px] font-bold uppercase tracking-wide">Icon</span>
              </span>
            )}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={(event) => pickIcon(event.target.files?.[0])}
          />
        </div>

        <Field label="Server name" error={error ?? undefined} required>
          <Input
            autoFocus
            value={name}
            maxLength={LIMITS.SERVER_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            placeholder="Study Group"
            invalid={Boolean(error)}
          />
        </Field>

        <Field label="Description" hint="Optional. Shown on the invite page.">
          <Textarea
            rows={2}
            value={description}
            maxLength={LIMITS.SERVER_DESCRIPTION_MAX}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this server for?"
          />
        </Field>

        <p className="text-[12px] leading-relaxed text-ink-faint">
          A <code className="rounded bg-surface-3 px-1">#general</code> text channel, a voice
          channel, and Admin / Moderator roles are created for you.
        </p>
      </div>
    </Modal>
  );
}
