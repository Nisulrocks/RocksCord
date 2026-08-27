/**
 * Create a text or voice channel.
 *
 * Text channel names are previewed in their slugified form as you type, so it is obvious
 * that "My Cool Channel" becomes `#my-cool-channel` before you commit to it.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hash, Volume2 } from 'lucide-react';
import clsx from 'clsx';
import { LIMITS } from '@rockscord/shared';
import type { Channel } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { Modal } from '../ui/Modal';
import { Button, Field, Input, Textarea } from '../ui/primitives';

/** Mirrors the server's `sanitizeChannelName` so the preview is truthful. */
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\-_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
}

export function CreateChannelModal({
  serverId,
  initialType = 'text',
  onClose,
}: {
  serverId: string;
  initialType?: 'text' | 'voice';
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const upsertChannel = useAppStore((s) => s.upsertChannel);

  const [type, setType] = useState<'text' | 'voice'>(initialType);
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const preview = type === 'text' ? slugify(name) : name.trim();

  const submit = async () => {
    if (!preview) {
      setError('Enter a channel name');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const response = await api.post<{ channel: Channel }>(
        `/api/channels/server/${serverId}`,
        { name: name.trim(), type, topic: topic.trim() || null },
      );
      upsertChannel(response.channel);
      onClose();
      if (response.channel.type === 'text') {
        navigate(`/channels/${serverId}/${response.channel.id}`);
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Could not create that channel');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Create channel"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!preview}>
            Create channel
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-ink-dim">
            Channel type
          </span>
          <div className="space-y-2">
            <TypeOption
              selected={type === 'text'}
              onSelect={() => setType('text')}
              icon={<Hash size={20} />}
              title="Text"
              description="Send messages, images, and files."
            />
            <TypeOption
              selected={type === 'voice'}
              onSelect={() => setType('voice')}
              icon={<Volume2 size={20} />}
              title="Voice"
              description="Talk with peer-to-peer audio and screen sharing."
            />
          </div>
        </div>

        <Field
          label="Channel name"
          error={error ?? undefined}
          hint={
            type === 'text' && preview
              ? `Will be created as #${preview}`
              : type === 'text'
                ? 'Spaces become hyphens.'
                : undefined
          }
          required
        >
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
              {type === 'text' ? <Hash size={16} /> : <Volume2 size={16} />}
            </span>
            <Input
              autoFocus
              value={name}
              maxLength={LIMITS.CHANNEL_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
              }}
              placeholder={type === 'text' ? 'new-channel' : 'General Voice'}
              className="pl-9"
              invalid={Boolean(error)}
            />
          </div>
        </Field>

        {type === 'text' && (
          <Field label="Topic" hint="Optional. Shown in the channel header.">
            <Textarea
              rows={2}
              value={topic}
              maxLength={LIMITS.CHANNEL_TOPIC_MAX}
              onChange={(event) => setTopic(event.target.value)}
              placeholder="What is this channel about?"
            />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function TypeOption({
  selected,
  onSelect,
  icon,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <button
      onClick={onSelect}
      className={clsx(
        'flex w-full items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
        selected
          ? 'border-accent bg-accent-wash'
          : 'border-line bg-surface-3 hover:border-line-strong',
      )}
    >
      <span className={clsx('shrink-0', selected ? 'text-accent-soft' : 'text-ink-faint')}>
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink">{title}</span>
        <span className="block text-[12px] text-ink-faint">{description}</span>
      </span>
      <span
        className={clsx(
          'h-4 w-4 shrink-0 rounded-full border-2 transition-colors',
          selected ? 'border-accent bg-accent' : 'border-line-strong',
        )}
      />
    </button>
  );
}
