/**
 * Managing a server's custom emoji.
 *
 * Uploading needs two things at once — a file and a name — so the flow is: pick an image,
 * then name it, then confirm. Asking for the name first would mean holding a name with
 * nothing attached; asking after the upload would mean uploading something that might be
 * rejected.
 */

import { useMemo, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { LIMITS, emojiNameSchema } from '@rockscord/shared';
import type { Emoji } from '@rockscord/shared';
import { api, ApiClientError } from '../../../lib/api';
import { useAppStore } from '../../../store/useAppStore';
import { useUiStore } from '../../../store/useUiStore';
import { Button, Field, Input } from '../../ui/primitives';

export function EmojiTab({ serverId }: { serverId: string }) {
  const allEmojis = useAppStore((s) => s.emojis);
  const toast = useUiStore((s) => s.toast);
  const openModal = useUiStore((s) => s.openModal);

  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ file: File; preview: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const emojis = useMemo(
    () =>
      Object.values(allEmojis)
        .filter((emoji: Emoji) => emoji.serverId === serverId)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allEmojis, serverId],
  );

  const full = emojis.length >= LIMITS.MAX_EMOJIS_PER_SERVER;

  const choose = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setPending({ file, preview: URL.createObjectURL(file) });
    // Seed the name from the filename, which is usually what someone wanted anyway.
    setName(
      file.name
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .slice(0, 32),
    );
  };

  const clear = () => {
    if (pending) URL.revokeObjectURL(pending.preview);
    setPending(null);
    setName('');
    setError(null);
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async () => {
    if (!pending) return;

    const parsed = emojiNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Check the name');
      return;
    }

    setBusy(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', pending.file);
      await api.upload(
        `/api/files/emoji/${serverId}?name=${encodeURIComponent(parsed.data)}`,
        formData,
      );
      // The socket event adds it to the store, so there is nothing to insert here.
      toast(`:${parsed.data}: added`, 'success');
      clear();
    } catch (caught) {
      setError(caught instanceof ApiClientError ? caught.message : 'Could not upload that');
    } finally {
      setBusy(false);
    }
  };

  const remove = (emoji: Emoji) => {
    openModal({
      kind: 'confirm',
      title: `Delete :${emoji.name}:`,
      body: 'Messages that already use it will show its name instead. This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        try {
          await api.delete(`/api/servers/${serverId}/emojis/${emoji.id}`);
          toast('Emoji deleted', 'success');
        } catch (caught) {
          toast(
            caught instanceof ApiClientError ? caught.message : 'Could not delete that',
            'error',
          );
        }
      },
    });
  };

  return (
    <div className="space-y-5">
      <section>
        <h4 className="text-[14px] font-semibold text-ink">Add an emoji</h4>
        <p className="mt-1 text-[13px] text-ink-dim">
          Square images work best. Up to {Math.round(LIMITS.MAX_EMOJI_BYTES / 1024)} KB, and{' '}
          {LIMITS.MAX_EMOJIS_PER_SERVER} per server.
        </p>

        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(event) => choose(event.target.files?.[0])}
        />

        {!pending ? (
          <Button
            variant="secondary"
            className="mt-3"
            disabled={full}
            onClick={() => fileRef.current?.click()}
          >
            <Upload size={15} aria-hidden />
            {full ? 'Emoji limit reached' : 'Choose an image'}
          </Button>
        ) : (
          <div className="mt-3 flex items-start gap-3 rounded-lg border border-line bg-surface-3 p-3">
            <img
              src={pending.preview}
              alt=""
              className="h-14 w-14 shrink-0 rounded-md bg-surface-4 object-contain"
            />
            <div className="min-w-0 flex-1">
              <Field label="Name" error={error ?? undefined} hint="Used as :name: in messages">
                <Input
                  value={name}
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void submit();
                  }}
                  placeholder="party_cat"
                  invalid={Boolean(error)}
                />
              </Field>
              <div className="mt-2 flex gap-2">
                <Button size="sm" loading={busy} onClick={() => void submit()}>
                  Add emoji
                </Button>
                <Button size="sm" variant="ghost" onClick={clear}>
                  Cancel
                </Button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section>
        <h4 className="text-[14px] font-semibold text-ink">
          Emoji <span className="text-ink-faint">({emojis.length})</span>
        </h4>

        {emojis.length === 0 ? (
          <p className="mt-2 text-[13px] text-ink-faint">
            None yet. Anything you add here can be used by everyone in the server.
          </p>
        ) : (
          <ul className="mt-3 space-y-1">
            {emojis.map((emoji) => (
              <li
                key={emoji.id}
                className="group flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-3"
              >
                <img
                  src={emoji.imageUrl}
                  alt={`:${emoji.name}:`}
                  className="h-7 w-7 shrink-0 object-contain"
                />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
                  :{emoji.name}:
                </span>
                <button
                  type="button"
                  onClick={() => remove(emoji)}
                  title={`Delete :${emoji.name}:`}
                  className="rounded-md p-1.5 text-ink-faint opacity-0 transition-opacity hover:bg-danger/15 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <Trash2 size={15} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
