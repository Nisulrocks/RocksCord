/**
 * A single message row.
 *
 * Consecutive messages from the same author within a short window are "grouped": the
 * follow-ups hide the avatar and header and show their timestamp only on hover. That is
 * what makes a fast back-and-forth readable instead of a wall of repeated names.
 */

import { memo, useState } from 'react';
import { CornerUpLeft, MoreVertical, Pencil, Pin, Reply, SmilePlus, Trash2 } from 'lucide-react';
import clsx from 'clsx';
import { Permission } from '@rockscord/shared';
import type { Message } from '@rockscord/shared';
import { api, resolveAssetUrl } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { usePermissions, useMemberColor } from '../../hooks/usePermissions';
import { Avatar } from '../ui/Avatar';
import { MessageContent } from './MessageContent';
import { AttachmentList } from './Attachments';
import { EditComposer } from './EditComposer';
import { QUICK_REACTIONS } from './emoji';

interface MessageItemProps {
  message: Message;
  /** True when this continues a run from the same author. */
  grouped: boolean;
  channelId: string;
  serverId: string | null;
  /** Renders the "new messages" divider above this message. */
  showUnreadDivider?: boolean;
  /** Scroll to another message in this channel, loading it if necessary. */
  onJumpTo?: (messageId: string) => void;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatFull(timestamp: number): string {
  return new Date(timestamp).toLocaleString([], {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export const MessageItem = memo(function MessageItem({
  message,
  grouped,
  channelId,
  serverId,
  showUnreadDivider,
  onJumpTo,
}: MessageItemProps) {
  const currentUser = useAppStore((s) => s.user);
  const membersByServer = useAppStore((s) => s.membersByServer);
  const permissions = usePermissions(serverId, channelId);
  const nameColor = useMemberColor(serverId, message.authorId);

  const openProfileCard = useUiStore((s) => s.openProfileCard);
  const openContextMenu = useUiStore((s) => s.openContextMenu);
  const applyReaction = useAppStore((s) => s.applyReaction);
  const highlighted = useAppStore((s) => s.highlightedMessageId === message.id);
  const openModal = useUiStore((s) => s.openModal);
  const setReplyTarget = useUiStore((s) => s.setReplyTarget);
  const editingMessageId = useUiStore((s) => s.editingMessageId);
  const setEditingMessage = useUiStore((s) => s.setEditingMessage);
  const toast = useUiStore((s) => s.toast);

  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);

  const isAuthor = message.authorId === currentUser?.id;
  const canManage = permissions.can(Permission.MANAGE_MESSAGES);
  const canDelete = isAuthor || canManage;
  const isEditing = editingMessageId === message.id;

  // Nicknames win over display names inside a server.
  const member = serverId ? membersByServer[serverId]?.[message.authorId] : undefined;
  const displayName = member?.nickname ?? message.author.displayName;

  const mentionsMe =
    Boolean(currentUser) &&
    (message.mentionUserIds.includes(currentUser!.id) || message.mentionsEveryone);

  /* -------------------------------------------------------------------- */

  /**
   * Toggle a reaction, showing the result before the server has confirmed it.
   *
   * This used to wait for the round trip and let the socket event apply the change, which
   * meant a tap took as long as the slowest hop to answer -- seconds, on a free-tier
   * instance that may have been asleep. A reaction is a one-bit change the client can
   * predict exactly, so it is applied locally first and undone if the request fails.
   *
   * The echo that arrives afterwards is a no-op: `applyReaction` keys on the emoji and the
   * user, so applying the same change twice lands on the same state.
   */
  const toggleReaction = async (emoji: string) => {
    if (!currentUser) return;

    const added = !message.reactions.find((r) => r.emoji === emoji)?.me;
    const encoded = encodeURIComponent(emoji);

    applyReaction(channelId, message.id, emoji, currentUser.id, added);

    try {
      if (added) {
        await api.put(`/api/channels/${channelId}/messages/${message.id}/reactions/${encoded}`);
      } else {
        await api.delete(`/api/channels/${channelId}/messages/${message.id}/reactions/${encoded}`);
      }
    } catch {
      // Put it back. Leaving the optimistic state would show a reaction that no other
      // client can see, which is worse than the tap appearing not to have registered.
      applyReaction(channelId, message.id, emoji, currentUser.id, !added);
      toast('Could not update that reaction', 'error');
    }
  };

  const deleteMessage = () =>
    openModal({
      kind: 'confirm',
      title: 'Delete message?',
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        await api.delete(`/api/channels/${channelId}/messages/${message.id}`);
      },
    });

  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const items: {
      label: string;
      onSelect: () => void;
      danger?: boolean;
      separated?: boolean;
    }[] = [
      {
        label: 'Reply',
        onSelect: () => setReplyTarget(channelId, { id: message.id, author: displayName }),
      },
      {
        label: 'Copy text',
        onSelect: () => {
          void navigator.clipboard.writeText(message.content);
          toast('Copied', 'success');
        },
      },
      {
        label: 'Copy link',
        onSelect: () => {
          /*
           * An absolute URL, because the point of copying one is to paste it somewhere
           * else. `?m=` is read on load and jumps to the message, so the link survives a
           * cold open rather than only working for someone already in the channel.
           */
          const base = serverId ? `/channels/${serverId}/${channelId}` : `/dm/${channelId}`;
          void navigator.clipboard.writeText(`${window.location.origin}${base}?m=${message.id}`);
          toast('Link copied', 'success');
        },
      },
    ];

    if (isAuthor) {
      items.push({ label: 'Edit', onSelect: () => setEditingMessage(message.id) });
    }
    if (canManage) {
      items.push({
        label: message.pinned ? 'Unpin' : 'Pin to channel',
        separated: true,
        onSelect: async () => {
          const path = `/api/channels/${channelId}/messages/${message.id}/pin`;
          if (message.pinned) await api.delete(path);
          else await api.put(path);
        },
      });
    }
    if (canDelete) {
      items.push({ label: 'Delete', danger: true, separated: true, onSelect: deleteMessage });
    }

    openContextMenu({ x: event.clientX, y: event.clientY, items });
  };

  /* -------------------------------------------------------------------- */

  if (message.deleted) {
    return (
      <div className="px-4 py-0.5 pl-[72px] text-[13px] italic text-ink-faint">
        This message was deleted.
      </div>
    );
  }

  return (
    <>
      {showUnreadDivider && (
        <div className="relative my-2 flex items-center gap-2 px-4" role="separator">
          <div className="h-px flex-1 bg-danger/60" />
          <span className="rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            New
          </span>
        </div>
      )}

      <article
        // The anchor `jumpTo` scrolls to, and what a copied link resolves against.
        data-message-id={message.id}
        onContextMenu={onContextMenu}
        className={clsx(
          'group relative px-4 transition-colors',
          grouped ? 'py-[1px]' : 'mt-3 py-[1px]',
          highlighted
            ? // Wins over the mention tint: it is transient and answers "here it is".
              'bg-accent-wash'
            : mentionsMe
              ? 'bg-mention hover:bg-idle/20 border-l-2 border-idle pl-[14px]'
              : 'hover:bg-surface-3/50',
        )}
      >
        {/* Reply preview ------------------------------------------------- */}
        {message.replyTo && (
          <button
            type="button"
            // Jumping is only meaningful while the original still exists.
            disabled={!onJumpTo || message.replyTo.deleted}
            onClick={() => message.replyTo && onJumpTo?.(message.replyTo.id)}
            className="mb-0.5 flex w-full items-center gap-1.5 pl-[52px] text-left text-[13px] text-ink-faint enabled:hover:text-ink-dim disabled:cursor-default"
          >
            <CornerUpLeft size={12} className="shrink-0 -scale-y-100" />
            <Avatar
              userId={message.replyTo.authorId}
              name={message.replyTo.author?.displayName ?? '?'}
              src={message.replyTo.author?.avatarUrl}
              size={16}
            />
            <span className="font-medium text-ink-dim">
              {message.replyTo.author?.displayName ?? 'Unknown'}
            </span>
            <span className="truncate">
              {message.replyTo.deleted ? (
                <em>original message was deleted</em>
              ) : (
                message.replyTo.content
              )}
            </span>
          </button>
        )}

        <div className="flex gap-4">
          {/* Gutter: avatar, or a hover timestamp for grouped messages. */}
          <div className="w-10 shrink-0">
            {grouped ? (
              <time
                className="mt-[3px] block text-right text-[10px] leading-[22px] text-ink-faint opacity-0 transition-opacity group-hover:opacity-100"
                dateTime={new Date(message.createdAt).toISOString()}
                title={formatFull(message.createdAt)}
              >
                {new Date(message.createdAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </time>
            ) : (
              <button
                onClick={(event) =>
                  openProfileCard({
                    userId: message.authorId,
                    anchor: { x: event.clientX, y: event.clientY },
                  })
                }
                className="mt-0.5"
              >
                <Avatar
                  userId={message.authorId}
                  name={displayName}
                  src={message.author.avatarUrl}
                  size={40}
                />
              </button>
            )}
          </div>

          <div className="min-w-0 flex-1">
            {!grouped && (
              <div className="flex items-baseline gap-2">
                <button
                  onClick={(event) =>
                    openProfileCard({
                      userId: message.authorId,
                      anchor: { x: event.clientX, y: event.clientY },
                    })
                  }
                  className="text-[15px] font-semibold hover:underline"
                  style={{ color: nameColor ?? 'var(--color-ink)' }}
                >
                  {displayName}
                </button>
                <time
                  className="text-[11px] text-ink-faint"
                  dateTime={new Date(message.createdAt).toISOString()}
                  title={formatFull(message.createdAt)}
                >
                  {formatTime(message.createdAt)}
                </time>
                {message.pinned && (
                  <Pin size={11} className="text-idle" aria-label="Pinned" />
                )}
              </div>
            )}

            {isEditing ? (
              <EditComposer
                message={message}
                channelId={channelId}
                onDone={() => setEditingMessage(null)}
              />
            ) : (
              <>
                <MessageContent content={message.content} serverId={serverId} />
                {message.editedAt && (
                  <span
                    className="ml-1 text-[10px] text-ink-faint"
                    title={formatFull(message.editedAt)}
                  >
                    (edited)
                  </span>
                )}
              </>
            )}

            {message.attachments.length > 0 && (
              <AttachmentList attachments={message.attachments} />
            )}

            {message.reactions.length > 0 && (
              <div className="mt-1 flex flex-wrap gap-1">
                {message.reactions.map((reaction) => (
                  <button
                    key={reaction.emoji}
                    onClick={() => void toggleReaction(reaction.emoji)}
                    className={clsx(
                      'flex h-[26px] items-center gap-1 rounded-md border px-1.5 text-[13px] transition-colors',
                      reaction.me
                        ? 'border-accent bg-accent-wash text-accent-soft'
                        : 'border-line bg-surface-3 text-ink-dim hover:border-line-strong',
                    )}
                    title={reaction.me ? 'Remove your reaction' : 'Add reaction'}
                  >
                    <span>{reaction.emoji}</span>
                    <span className="tabular-nums">{reaction.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Hover toolbar ------------------------------------------------- */}
        {!isEditing && (
          <div className="absolute -top-3 right-4 hidden items-center gap-0.5 rounded-md border border-line bg-surface-4 p-0.5 shadow-pop group-hover:flex group-focus-within:flex">
            <div className="relative">
              <ToolbarButton
                label="Add reaction"
                onClick={() => setReactionPickerOpen((open) => !open)}
              >
                <SmilePlus size={16} />
              </ToolbarButton>
              {reactionPickerOpen && (
                <div className="animate-pop-in absolute right-0 top-full z-20 mt-1 flex gap-0.5 rounded-lg border border-line-strong bg-surface-4 p-1 shadow-pop">
                  {QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => {
                        setReactionPickerOpen(false);
                        void toggleReaction(emoji);
                      }}
                      className="rounded p-1 text-lg transition-transform hover:scale-125"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <ToolbarButton
              label="Reply"
              onClick={() => setReplyTarget(channelId, { id: message.id, author: displayName })}
            >
              <Reply size={16} />
            </ToolbarButton>

            {isAuthor && (
              <ToolbarButton label="Edit" onClick={() => setEditingMessage(message.id)}>
                <Pencil size={15} />
              </ToolbarButton>
            )}

            {canDelete && (
              <ToolbarButton label="Delete" onClick={deleteMessage} danger>
                <Trash2 size={15} />
              </ToolbarButton>
            )}

            <ToolbarButton
              label="More"
              onClick={(event) => {
                const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
                onContextMenu({
                  preventDefault: () => {},
                  clientX: rect.left,
                  clientY: rect.bottom,
                } as React.MouseEvent);
              }}
            >
              <MoreVertical size={15} />
            </ToolbarButton>
          </div>
        )}
      </article>
    </>
  );
});

function ToolbarButton({
  label,
  onClick,
  danger,
  children,
}: {
  label: string;
  onClick: (event: React.MouseEvent) => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      className={clsx(
        'flex h-7 w-7 items-center justify-center rounded transition-colors',
        danger ? 'text-ink-dim hover:bg-danger hover:text-white' : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
      )}
    >
      {children}
    </button>
  );
}

export { resolveAssetUrl };
