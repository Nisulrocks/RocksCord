/**
 * Message composer.
 *
 * Three behaviours worth calling out:
 *
 * 1. **Optimistic send.** The message appears immediately with a temporary id and is
 *    reconciled when the server responds. A `nonce` is echoed back so the real message
 *    can replace the placeholder rather than appearing twice.
 *
 * 2. **Background uploads.** Files start uploading the moment they are attached, while
 *    the user is still typing. By the time they hit Enter the upload is usually done, so
 *    sending is instant. This is why the server records attachments before the message
 *    exists and "claims" them at send time.
 *
 * 3. **Mention autocomplete.** Typing `@` opens an inline picker; selecting inserts the
 *    stable `<@id>` token rather than the display name, so renames never break mentions.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { Plus, SendHorizonal, Smile, X } from 'lucide-react';
import clsx from 'clsx';
import { LIMITS, Permission, userMention } from '@rockscord/shared';
import type { Attachment, Message } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { sendTyping } from '../../lib/socket';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { usePermissions } from '../../hooks/usePermissions';
import { Avatar } from '../ui/Avatar';
import { IconButton, Spinner } from '../ui/primitives';
import { EmojiPicker } from './EmojiPicker';

interface PendingUpload {
  /** Local id, replaced by the server attachment id once uploaded. */
  localId: string;
  file: File;
  previewUrl: string | null;
  attachment: Attachment | null;
  error: string | null;
}

export function Composer({
  channelId,
  serverId,
  placeholder,
}: {
  channelId: string;
  serverId: string | null;
  placeholder: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const draft = useUiStore((s) => s.drafts[channelId] ?? '');
  const setDraft = useUiStore((s) => s.setDraft);
  const clearDraft = useUiStore((s) => s.clearDraft);
  const replyTarget = useUiStore((s) => s.replyTargets[channelId]);
  const setReplyTarget = useUiStore((s) => s.setReplyTarget);
  const toast = useUiStore((s) => s.toast);

  const membersByServer = useAppStore((s) => s.membersByServer);
  const dmChannels = useAppStore((s) => s.dmChannels);
  const addMessage = useAppStore((s) => s.addMessage);
  const removeMessage = useAppStore((s) => s.removeMessage);

  const permissions = usePermissions(serverId, channelId);
  const canSend = permissions.can(Permission.SEND_MESSAGES);
  const canAttach = permissions.can(Permission.ATTACH_FILES);

  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [sending, setSending] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dragging, setDragging] = useState(false);

  /* -------------------------------------------------------------------- */
  /* Auto-resize                                                           */
  /* -------------------------------------------------------------------- */

  const resize = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    // Grow with the content up to ~10 lines, then scroll internally.
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, []);

  useEffect(resize, [draft, resize]);

  // Focusing on channel change means you can just start typing after clicking a channel.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [channelId]);

  /* -------------------------------------------------------------------- */
  /* Mention autocomplete                                                  */
  /* -------------------------------------------------------------------- */

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];

    const pool = serverId
      ? Object.values(membersByServer[serverId] ?? {}).map((member) => ({
          id: member.userId,
          name: member.nickname ?? member.user.displayName,
          username: member.user.username,
          avatarUrl: member.user.avatarUrl,
        }))
      : (dmChannels[channelId]?.recipients ?? []).map((user) => ({
          id: user.id,
          name: user.displayName,
          username: user.username,
          avatarUrl: user.avatarUrl,
        }));

    const term = mentionQuery.toLowerCase();
    return pool
      .filter(
        (candidate) =>
          candidate.name.toLowerCase().includes(term) ||
          candidate.username.toLowerCase().includes(term),
      )
      .slice(0, 8);
  }, [mentionQuery, serverId, membersByServer, dmChannels, channelId]);

  /** Detect an in-progress `@word` immediately before the caret. */
  const updateMentionState = useCallback((value: string, caret: number) => {
    const upToCaret = value.slice(0, caret);
    const match = /(?:^|\s)@([\w.\-]*)$/.exec(upToCaret);
    setMentionQuery(match ? (match[1] ?? '') : null);
    setMentionIndex(0);
  }, []);

  const insertMention = useCallback(
    (candidate: { id: string; name: string }) => {
      const element = textareaRef.current;
      if (!element) return;

      const caret = element.selectionStart;
      const before = draft.slice(0, caret).replace(/@[\w.\-]*$/, '');
      const after = draft.slice(caret);
      const next = `${before}${userMention(candidate.id)} ${after}`;

      setDraft(channelId, next);
      setMentionQuery(null);

      // Put the caret just after the inserted token plus its trailing space.
      requestAnimationFrame(() => {
        const position = before.length + userMention(candidate.id).length + 1;
        element.focus();
        element.setSelectionRange(position, position);
      });
    },
    [draft, channelId, setDraft],
  );

  /* -------------------------------------------------------------------- */
  /* Uploads                                                               */
  /* -------------------------------------------------------------------- */

  const startUpload = useCallback(
    async (files: File[]) => {
      if (!canAttach) {
        toast('You cannot upload files in this channel', 'error');
        return;
      }

      const room = LIMITS.MAX_ATTACHMENTS_PER_MESSAGE - uploads.length;
      if (room <= 0) {
        toast(`Up to ${LIMITS.MAX_ATTACHMENTS_PER_MESSAGE} files per message`, 'error');
        return;
      }

      const accepted = files.slice(0, room);

      for (const file of accepted) {
        if (file.size > LIMITS.MAX_UPLOAD_BYTES) {
          toast(
            `${file.name} is larger than ${LIMITS.MAX_UPLOAD_BYTES / (1024 * 1024)} MB`,
            'error',
          );
          continue;
        }

        const localId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;

        setUploads((current) => [
          ...current,
          { localId, file, previewUrl, attachment: null, error: null },
        ]);

        const formData = new FormData();
        formData.append('file', file);

        try {
          const response = await api.upload<{ attachment: Attachment }>(
            '/api/files/upload',
            formData,
          );
          setUploads((current) =>
            current.map((upload) =>
              upload.localId === localId
                ? { ...upload, attachment: response.attachment }
                : upload,
            ),
          );
        } catch (error) {
          const message =
            error instanceof ApiClientError ? error.message : 'Upload failed';
          setUploads((current) =>
            current.map((upload) =>
              upload.localId === localId ? { ...upload, error: message } : upload,
            ),
          );
        }
      }
    },
    [canAttach, uploads.length, toast],
  );

  const removeUpload = useCallback((localId: string) => {
    setUploads((current) => {
      const target = current.find((upload) => upload.localId === localId);
      // Release the object URL or the blob leaks for the lifetime of the page.
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((upload) => upload.localId !== localId);
    });
  }, []);

  useEffect(
    () => () => {
      for (const upload of uploads) {
        if (upload.previewUrl) URL.revokeObjectURL(upload.previewUrl);
      }
    },
    // Only on unmount: revoking on every change would break previews still in use.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /* -------------------------------------------------------------------- */
  /* Send                                                                  */
  /* -------------------------------------------------------------------- */

  const send = useCallback(async () => {
    const content = draft.trim();
    const ready = uploads.filter((upload) => upload.attachment);
    const stillUploading = uploads.some((upload) => !upload.attachment && !upload.error);

    if (stillUploading) {
      toast('Waiting for uploads to finish…', 'info');
      return;
    }
    if (!content && ready.length === 0) return;
    if (sending) return;

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const me = useAppStore.getState().user;
    if (!me) return;

    // Optimistic placeholder. Its id is prefixed so it can never collide with a ULID.
    const optimisticId = `pending-${nonce}`;
    const optimistic: Message = {
      id: optimisticId,
      channelId,
      authorId: me.id,
      author: me,
      content,
      createdAt: Date.now(),
      editedAt: null,
      replyToId: replyTarget?.id ?? null,
      replyTo: null,
      attachments: ready.map((upload) => upload.attachment!),
      reactions: [],
      mentionUserIds: [],
      mentionsEveryone: false,
      pinned: false,
      deleted: false,
    };

    setSending(true);
    addMessage(optimistic);
    clearDraft(channelId);
    setUploads([]);
    setReplyTarget(channelId, null);

    try {
      await api.post(`/api/channels/${channelId}/messages`, {
        content,
        replyToId: replyTarget?.id ?? null,
        attachmentIds: ready.map((upload) => upload.attachment!.id),
        nonce,
      });
      // The real message arrives via the socket; drop the placeholder.
      removeMessage(channelId, optimisticId);
      useAppStore.setState((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: (state.messagesByChannel[channelId] ?? []).filter(
            (message) => message.id !== optimisticId,
          ),
        },
      }));
    } catch (error) {
      // Restore what the user typed so nothing is lost.
      useAppStore.setState((state) => ({
        messagesByChannel: {
          ...state.messagesByChannel,
          [channelId]: (state.messagesByChannel[channelId] ?? []).filter(
            (message) => message.id !== optimisticId,
          ),
        },
      }));
      setDraft(channelId, content);
      toast(
        error instanceof ApiClientError ? error.message : 'Could not send that message',
        'error',
      );
    } finally {
      setSending(false);
      requestAnimationFrame(resize);
    }
  }, [
    draft,
    uploads,
    sending,
    channelId,
    replyTarget,
    addMessage,
    removeMessage,
    clearDraft,
    setDraft,
    setReplyTarget,
    toast,
    resize,
  ]);

  /* -------------------------------------------------------------------- */
  /* Keyboard                                                              */
  /* -------------------------------------------------------------------- */

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionQuery !== null && mentionCandidates.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionIndex((index) => (index + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionIndex(
          (index) => (index - 1 + mentionCandidates.length) % mentionCandidates.length,
        );
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        const candidate = mentionCandidates[mentionIndex];
        if (candidate) insertMention(candidate);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setMentionQuery(null);
        return;
      }
    }

    // Enter sends; Shift+Enter inserts a newline.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
      return;
    }

    if (event.key === 'Escape' && replyTarget) {
      event.preventDefault();
      setReplyTarget(channelId, null);
    }
  };

  const onChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    setDraft(channelId, value);
    updateMentionState(value, event.target.selectionStart);
    if (value.trim()) sendTyping(channelId);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...event.clipboardData.files];
    if (files.length > 0) {
      event.preventDefault();
      void startUpload(files);
    }
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = [...event.dataTransfer.files];
    if (files.length > 0) void startUpload(files);
  };

  /* -------------------------------------------------------------------- */

  if (!canSend) {
    return (
      <div className="px-4 pb-5 pt-1">
        <div className="rounded-lg border border-line bg-surface-3 px-4 py-3 text-center text-[14px] text-ink-faint">
          You do not have permission to send messages in this channel.
        </div>
      </div>
    );
  }

  const overLimit = draft.length > LIMITS.MESSAGE_MAX;

  return (
    <div className="px-4 pb-5 pt-1">
      {/* Reply banner --------------------------------------------------- */}
      {replyTarget && (
        <div className="flex items-center justify-between gap-2 rounded-t-lg border border-b-0 border-line bg-surface-3 px-3 py-1.5 text-[13px] text-ink-dim">
          <span className="truncate">
            Replying to <span className="font-semibold text-ink">{replyTarget.author}</span>
          </span>
          <button
            onClick={() => setReplyTarget(channelId, null)}
            className="shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
            aria-label="Cancel reply"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Attachment tray ------------------------------------------------ */}
      {uploads.length > 0 && (
        <div
          className={clsx(
            'flex flex-wrap gap-2 border border-b-0 border-line bg-surface-3 p-2',
            replyTarget ? '' : 'rounded-t-lg',
          )}
        >
          {uploads.map((upload) => (
            <div
              key={upload.localId}
              className="group/upload relative h-20 w-20 overflow-hidden rounded-lg border border-line bg-surface-0"
            >
              {upload.previewUrl ? (
                <img
                  src={upload.previewUrl}
                  alt={upload.file.name}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full items-center justify-center px-1 text-center text-[10px] leading-tight text-ink-faint">
                  {upload.file.name}
                </div>
              )}

              {!upload.attachment && !upload.error && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                  <Spinner size={18} className="text-white" />
                </div>
              )}
              {upload.error && (
                <div className="absolute inset-0 flex items-center justify-center bg-danger/80 px-1 text-center text-[10px] text-white">
                  {upload.error}
                </div>
              )}

              <button
                onClick={() => removeUpload(upload.localId)}
                className="absolute right-1 top-1 rounded bg-black/70 p-0.5 text-white opacity-0 transition-opacity group-hover/upload:opacity-100"
                aria-label={`Remove ${upload.file.name}`}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input ---------------------------------------------------------- */}
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={clsx(
          'relative flex items-end gap-1 border border-line bg-surface-3 px-2 py-1.5 transition-colors',
          replyTarget || uploads.length > 0 ? 'rounded-b-lg' : 'rounded-lg',
          dragging && 'border-accent bg-accent-wash',
          overLimit && 'border-danger',
        )}
      >
        {/* Mention picker ---------------------------------------------- */}
        {mentionQuery !== null && mentionCandidates.length > 0 && (
          <div className="animate-pop-in absolute bottom-full left-0 z-20 mb-2 w-72 overflow-hidden rounded-lg border border-line-strong bg-surface-4 py-1 shadow-pop">
            <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider text-ink-faint">
              Members
            </div>
            {mentionCandidates.map((candidate, index) => (
              <button
                key={candidate.id}
                onMouseEnter={() => setMentionIndex(index)}
                onClick={() => insertMention(candidate)}
                className={clsx(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[14px]',
                  index === mentionIndex ? 'bg-accent text-white' : 'text-ink-dim',
                )}
              >
                <Avatar
                  userId={candidate.id}
                  name={candidate.name}
                  src={candidate.avatarUrl}
                  size={22}
                />
                <span className="truncate font-medium">{candidate.name}</span>
                <span
                  className={clsx(
                    'ml-auto truncate text-[12px]',
                    index === mentionIndex ? 'text-white/70' : 'text-ink-faint',
                  )}
                >
                  {candidate.username}
                </span>
              </button>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            void startUpload([...(event.target.files ?? [])]);
            // Reset so selecting the same file twice in a row still fires onChange.
            event.target.value = '';
          }}
        />

        <IconButton
          label="Attach a file"
          onClick={() => fileInputRef.current?.click()}
          disabled={!canAttach}
          className="mb-0.5 shrink-0"
        >
          <Plus size={20} />
        </IconButton>

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={(event) =>
            updateMentionState(draft, (event.target as HTMLTextAreaElement).selectionStart)
          }
          placeholder={placeholder}
          rows={1}
          className="scrollbar-slim max-h-[240px] min-h-[24px] flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-[1.4] text-ink outline-none placeholder:text-ink-faint"
        />

        <div className="relative mb-0.5 flex shrink-0 items-center">
          {overLimit && (
            <span className="mr-1 text-[12px] font-medium tabular-nums text-danger">
              {LIMITS.MESSAGE_MAX - draft.length}
            </span>
          )}

          <IconButton label="Emoji" onClick={() => setEmojiOpen((open) => !open)}>
            <Smile size={20} />
          </IconButton>

          {emojiOpen && (
            <EmojiPicker
              serverId={serverId}
              onSelect={(emoji) => {
                const element = textareaRef.current;
                const caret = element?.selectionStart ?? draft.length;
                setDraft(channelId, draft.slice(0, caret) + emoji + draft.slice(caret));
                setEmojiOpen(false);
                requestAnimationFrame(() => {
                  element?.focus();
                  const position = caret + emoji.length;
                  element?.setSelectionRange(position, position);
                });
              }}
              onClose={() => setEmojiOpen(false)}
            />
          )}

          <IconButton
            label="Send"
            onClick={() => void send()}
            disabled={sending || overLimit || (!draft.trim() && uploads.length === 0)}
            className="text-accent-soft"
          >
            {sending ? <Spinner size={17} /> : <SendHorizonal size={19} />}
          </IconButton>
        </div>
      </div>
    </div>
  );
}
