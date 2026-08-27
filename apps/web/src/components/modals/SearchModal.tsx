/**
 * Search across messages, people, and channels.
 *
 * Queries are debounced and each new one supersedes the last — an out-of-order response
 * from a slower earlier request must never overwrite newer results, which is what the
 * request-sequence guard below prevents.
 */

import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Hash, MessageSquare, Search as SearchIcon, User, Volume2 } from 'lucide-react';
import clsx from 'clsx';
import type { Message, PublicUser } from '@rockscord/shared';
import { api } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { Modal } from '../ui/Modal';
import { Avatar } from '../ui/Avatar';
import { Input, Spinner } from '../ui/primitives';

type Scope = 'messages' | 'people' | 'channels';

interface MessageHit extends Message {
  channel: { id: string; name: string; serverId: string | null } | null;
}

interface ChannelHit {
  id: string;
  name: string;
  type: string;
  serverId: string | null;
}

export function SearchModal({
  serverId,
  channelId,
  onClose,
}: {
  serverId?: string;
  channelId?: string;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const openProfileCard = useUiStore((s) => s.openProfileCard);
  const servers = useAppStore((s) => s.servers);

  const [scope, setScope] = useState<Scope>('messages');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<MessageHit[]>([]);
  const [people, setPeople] = useState<PublicUser[]>([]);
  const [channels, setChannels] = useState<ChannelHit[]>([]);
  const [usedIndex, setUsedIndex] = useState(true);
  const [scopeToChannel, setScopeToChannel] = useState(Boolean(channelId));

  /** Monotonic request id; only the newest response is allowed to write state. */
  const sequence = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 1) {
      setMessages([]);
      setPeople([]);
      setChannels([]);
      return;
    }

    const id = ++sequence.current;
    setLoading(true);

    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: term });
        if (scope === 'messages') {
          if (serverId) params.set('serverId', serverId);
          if (channelId && scopeToChannel) params.set('channelId', channelId);

          const response = await api.get<{ messages: MessageHit[]; usedIndex: boolean }>(
            `/api/search/messages?${params}`,
          );
          if (id !== sequence.current) return;
          setMessages(response.messages);
          setUsedIndex(response.usedIndex);
        } else if (scope === 'people') {
          const response = await api.get<{ users: PublicUser[] }>(`/api/search/users?${params}`);
          if (id !== sequence.current) return;
          setPeople(response.users);
        } else {
          const response = await api.get<{ channels: ChannelHit[] }>(
            `/api/search/servers?${params}`,
          );
          if (id !== sequence.current) return;
          setChannels(response.channels);
        }
      } catch {
        if (id === sequence.current) {
          setMessages([]);
          setPeople([]);
          setChannels([]);
        }
      } finally {
        if (id === sequence.current) setLoading(false);
      }
    }, 280);

    return () => window.clearTimeout(timer);
  }, [query, scope, serverId, channelId, scopeToChannel]);

  const openMessage = (hit: MessageHit) => {
    if (!hit.channel) return;
    onClose();
    if (hit.channel.serverId) {
      navigate(`/channels/${hit.channel.serverId}/${hit.channel.id}`);
    } else {
      navigate(`/dm/${hit.channel.id}`);
    }
  };

  const tabs: { key: Scope; label: string; icon: React.ReactNode }[] = [
    { key: 'messages', label: 'Messages', icon: <MessageSquare size={14} /> },
    { key: 'people', label: 'People', icon: <User size={14} /> },
    { key: 'channels', label: 'Channels', icon: <Hash size={14} /> },
  ];

  return (
    <Modal open onClose={onClose} title="Search" width="lg">
      <div className="relative mb-3">
        <SearchIcon
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"
        />
        <Input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            scope === 'messages'
              ? 'Search messages you can see…'
              : scope === 'people'
                ? 'Search by username…'
                : 'Search your channels…'
          }
          className="pl-9"
        />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-1">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            onClick={() => setScope(tab.key)}
            className={clsx(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[13px] transition-colors',
              scope === tab.key
                ? 'bg-surface-4 text-ink'
                : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
            )}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}

        {scope === 'messages' && channelId && (
          <label className="ml-auto flex cursor-pointer items-center gap-1.5 text-[12px] text-ink-dim">
            <input
              type="checkbox"
              checked={scopeToChannel}
              onChange={(event) => setScopeToChannel(event.target.checked)}
              className="accent-[var(--color-accent)]"
            />
            This channel only
          </label>
        )}
      </div>

      <div className="min-h-[240px]">
        {loading && (
          <div className="flex items-center gap-2 py-6 text-[13px] text-ink-faint">
            <Spinner size={15} /> Searching…
          </div>
        )}

        {!loading && query.trim() && (
          <>
            {scope === 'messages' && (
              <>
                {messages.length === 0 ? (
                  <Empty term={query} />
                ) : (
                  <ul className="divide-y divide-line">
                    {messages.map((hit) => (
                      <li key={hit.id}>
                        <button
                          onClick={() => openMessage(hit)}
                          className="flex w-full items-start gap-3 px-1 py-2.5 text-left transition-colors hover:bg-surface-3"
                        >
                          <Avatar
                            userId={hit.authorId}
                            name={hit.author.displayName}
                            src={hit.author.avatarUrl}
                            size={32}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-baseline gap-2">
                              <span className="truncate text-[14px] font-medium text-ink">
                                {hit.author.displayName}
                              </span>
                              <span className="shrink-0 text-[11px] text-ink-faint">
                                {new Date(hit.createdAt).toLocaleString()}
                              </span>
                            </span>
                            <span className="mt-0.5 line-clamp-2 block text-[13px] text-ink-dim">
                              {hit.content}
                            </span>
                            {hit.channel && (
                              <span className="mt-0.5 block text-[11px] text-ink-faint">
                                in{' '}
                                {hit.channel.serverId
                                  ? `#${hit.channel.name} · ${servers[hit.channel.serverId]?.name ?? ''}`
                                  : 'a direct message'}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                {!usedIndex && messages.length > 0 && (
                  <p className="mt-3 text-[11px] text-ink-faint">
                    Full-text index unavailable — showing substring matches instead.
                  </p>
                )}
              </>
            )}

            {scope === 'people' &&
              (people.length === 0 ? (
                <Empty term={query} />
              ) : (
                <ul className="divide-y divide-line">
                  {people.map((user) => (
                    <li key={user.id}>
                      <button
                        onClick={(event) => {
                          onClose();
                          openProfileCard({
                            userId: user.id,
                            anchor: { x: event.clientX, y: event.clientY },
                          });
                        }}
                        className="flex w-full items-center gap-3 px-1 py-2.5 text-left transition-colors hover:bg-surface-3"
                      >
                        <Avatar
                          userId={user.id}
                          name={user.displayName}
                          src={user.avatarUrl}
                          size={34}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-[14px] font-medium text-ink">
                            {user.displayName}
                          </span>
                          <span className="block truncate text-[12px] text-ink-faint">
                            {user.username}#{user.discriminator}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ))}

            {scope === 'channels' &&
              (channels.length === 0 ? (
                <Empty term={query} />
              ) : (
                <ul className="divide-y divide-line">
                  {channels.map((channel) => (
                    <li key={channel.id}>
                      <button
                        onClick={() => {
                          onClose();
                          if (channel.serverId) {
                            navigate(`/channels/${channel.serverId}/${channel.id}`);
                          }
                        }}
                        className="flex w-full items-center gap-2.5 px-1 py-2.5 text-left transition-colors hover:bg-surface-3"
                      >
                        {channel.type === 'voice' ? (
                          <Volume2 size={16} className="text-ink-faint" />
                        ) : (
                          <Hash size={16} className="text-ink-faint" />
                        )}
                        <span className="text-[14px] text-ink">{channel.name}</span>
                        {channel.serverId && (
                          <span className="ml-auto text-[12px] text-ink-faint">
                            {servers[channel.serverId]?.name}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              ))}
          </>
        )}

        {!query.trim() && (
          <div className="py-10 text-center text-[13px] text-ink-faint">
            Start typing to search. Results are limited to channels you can already see.
          </div>
        )}
      </div>
    </Modal>
  );
}

function Empty({ term }: { term: string }) {
  return (
    <div className="py-10 text-center">
      <p className="text-[14px] text-ink-dim">No results for “{term}”</p>
      <p className="mt-1 text-[12px] text-ink-faint">Try a different word or a shorter phrase.</p>
    </div>
  );
}
