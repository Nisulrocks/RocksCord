/**
 * Inline message editor.
 *
 * Replaces the message body in place rather than opening a modal, so the surrounding
 * conversation stays visible while editing. Enter saves, Escape cancels — matching the
 * main composer's muscle memory.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { LIMITS } from '@rockscord/shared';
import type { Message } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { useUiStore } from '../../store/useUiStore';

export function EditComposer({
  message,
  channelId,
  onDone,
}: {
  message: Message;
  channelId: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toast = useUiStore((s) => s.toast);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.focus();
    // Caret to the end, so editing continues from where the message left off.
    element.setSelectionRange(element.value.length, element.value.length);
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 300)}px`;
  }, []);

  const save = async () => {
    const content = value.trim();

    if (!content) {
      toast('A message cannot be empty. Delete it instead.', 'error');
      return;
    }
    if (content === message.content) {
      onDone();
      return;
    }

    setSaving(true);
    try {
      await api.patch(`/api/channels/${channelId}/messages/${message.id}`, { content });
      onDone();
    } catch (error) {
      toast(
        error instanceof ApiClientError ? error.message : 'Could not save that edit',
        'error',
      );
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onDone();
    }
  };

  return (
    <div className="my-1">
      <textarea
        ref={textareaRef}
        value={value}
        disabled={saving}
        maxLength={LIMITS.MESSAGE_MAX}
        onChange={(event) => {
          setValue(event.target.value);
          event.target.style.height = 'auto';
          event.target.style.height = `${Math.min(event.target.scrollHeight, 300)}px`;
        }}
        onKeyDown={onKeyDown}
        className="scrollbar-slim w-full resize-none rounded-lg border border-line bg-surface-0 px-3 py-2 text-[15px] leading-[1.45] text-ink outline-none focus:border-accent"
      />
      <div className="mt-1 text-[12px] text-ink-faint">
        escape to{' '}
        <button onClick={onDone} className="text-accent-soft hover:underline">
          cancel
        </button>
        {' · '}
        enter to{' '}
        <button onClick={() => void save()} className="text-accent-soft hover:underline">
          save
        </button>
      </div>
    </div>
  );
}
