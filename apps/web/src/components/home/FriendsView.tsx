/**
 * The friends screen: online, all, pending, and blocked, plus "add friend".
 *
 * Friendship actions here are optimistic in effect but not in state: they call the API and
 * let the resulting socket event update the store, so both sides of a friendship converge
 * on exactly the same data with no client-side guessing about what the server decided.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, Menu, MessageSquare, UserPlus, UserX, X } from 'lucide-react';
import clsx from 'clsx';
import type { Friendship } from '@rockscord/shared';
import { api, ApiClientError } from '../../lib/api';
import { useAppStore } from '../../store/useAppStore';
import { useUiStore } from '../../store/useUiStore';
import { Avatar } from '../ui/Avatar';
import { Button, EmptyState, IconButton, Input } from '../ui/primitives';

type Tab = 'online' | 'all' | 'pending' | 'add';

export function FriendsView() {
  const navigate = useNavigate();

  const friends = useAppStore((s) => s.friends);
  const incoming = useAppStore((s) => s.incomingRequests);
  const outgoing = useAppStore((s) => s.outgoingRequests);
  const presence = useAppStore((s) => s.presence);
  const upsertDMChannel = useAppStore((s) => s.upsertDMChannel);
  const removeFriendOf = useAppStore((s) => s.removeFriendOf);
  const upsertFriendship = useAppStore((s) => s.upsertFriendship);

  const toast = useUiStore((s) => s.toast);
  const openProfileCard = useUiStore((s) => s.openProfileCard);
  const setMobilePane = useUiStore((s) => s.setMobilePane);

  const [tab, setTab] = useState<Tab>('online');

  const onlineFriends = friends.filter(
    (friendship) => (presence[friendship.user.id]?.status ?? 'offline') !== 'offline',
  );

  const openDm = async (userId: string) => {
    try {
      const response = await api.post<{ channel: { id: string } }>('/api/dms', { userId });
      // Reload the DM list so the sidebar has the new conversation before we navigate.
      const list = await api.get<{ channels: Parameters<typeof upsertDMChannel>[0][] }>('/api/dms');
      for (const channel of list.channels) upsertDMChannel(channel);
      navigate(`/dm/${response.channel.id}`);
      setMobilePane('chat');
    } catch (error) {
      toast(
        error instanceof ApiClientError ? error.message : 'Could not open that conversation',
        'error',
      );
    }
  };

  const accept = async (friendship: Friendship) => {
    try {
      const response = await api.post<{ friendship: Friendship }>(
        `/api/friends/${friendship.id}/accept`,
      );
      upsertFriendship(response.friendship);
      toast(`You are now friends with ${friendship.user.displayName}`, 'success');
    } catch {
      toast('Could not accept that request', 'error');
    }
  };

  const remove = async (friendship: Friendship, verb: string) => {
    try {
      await api.delete(`/api/friends/${friendship.id}`);
      removeFriendOf(friendship.user.id);
      toast(`${verb} ${friendship.user.displayName}`, 'success');
    } catch {
      toast('That did not work', 'error');
    }
  };

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'online', label: 'Online', count: onlineFriends.length },
    { key: 'all', label: 'All', count: friends.length },
    { key: 'pending', label: 'Pending', count: incoming.length + outgoing.length },
    { key: 'add', label: 'Add friend' },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-4">
        {/*
          * The same escape hatch the chat header has. Without it this screen is a dead end
          * on a phone: it is where you land after signing in, the rail and channel list are
          * off-screen at that width, and nothing else here opens them.
          */}
        <IconButton
          label="Show servers"
          onClick={() => setMobilePane('sidebar')}
          className="-ml-1 mr-1 md:hidden"
        >
          <Menu size={18} />
        </IconButton>

        <div className="flex items-center gap-2 pr-3 text-[15px] font-semibold text-ink">
          <UserPlus size={19} className="text-ink-faint" />
          Friends
        </div>
        <div className="h-5 w-px bg-line" />
        <nav className="flex items-center gap-1 overflow-x-auto pl-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {tabs.map((item) => (
            <button
              key={item.key}
              onClick={() => setTab(item.key)}
              className={clsx(
                'flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-[14px] transition-colors',
                item.key === 'add'
                  ? tab === 'add'
                    ? 'bg-online/20 text-online'
                    : 'text-online hover:bg-online/10'
                  : tab === item.key
                    ? 'bg-surface-4 text-ink'
                    : 'text-ink-dim hover:bg-surface-3 hover:text-ink',
              )}
            >
              {item.label}
              {item.count !== undefined && item.count > 0 && item.key === 'pending' && (
                <span className="rounded-full bg-danger px-1.5 text-[11px] font-bold text-white">
                  {item.count}
                </span>
              )}
            </button>
          ))}
        </nav>
      </header>

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-6 py-4">
        {tab === 'add' && <AddFriendPanel />}

        {tab === 'online' && (
          <FriendList
            title={`Online — ${onlineFriends.length}`}
            friendships={onlineFriends}
            empty="Nobody is online right now."
            onOpenDm={openDm}
            onRemove={(friendship) => void remove(friendship, 'Removed')}
            onOpenProfile={openProfileCard}
          />
        )}

        {tab === 'all' && (
          <FriendList
            title={`All friends — ${friends.length}`}
            friendships={friends}
            empty="You have not added anyone yet. Try the Add friend tab."
            onOpenDm={openDm}
            onRemove={(friendship) => void remove(friendship, 'Removed')}
            onOpenProfile={openProfileCard}
          />
        )}

        {tab === 'pending' && (
          <>
            {incoming.length === 0 && outgoing.length === 0 && (
              <EmptyState
                icon={<UserPlus size={40} />}
                title="No pending requests"
                body="When someone sends you a friend request it will show up here."
              />
            )}

            {incoming.length > 0 && (
              <section className="mb-6">
                <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                  Incoming — {incoming.length}
                </h3>
                <ul className="divide-y divide-line">
                  {incoming.map((friendship) => (
                    <FriendRow
                      key={friendship.id}
                      friendship={friendship}
                      subtitle="Incoming friend request"
                      onOpenProfile={openProfileCard}
                      actions={
                        <>
                          <IconButton label="Accept" onClick={() => void accept(friendship)}>
                            <Check size={17} className="text-online" />
                          </IconButton>
                          <IconButton
                            label="Reject"
                            onClick={() => void remove(friendship, 'Rejected the request from')}
                          >
                            <X size={17} className="text-danger" />
                          </IconButton>
                        </>
                      }
                    />
                  ))}
                </ul>
              </section>
            )}

            {outgoing.length > 0 && (
              <section>
                <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
                  Outgoing — {outgoing.length}
                </h3>
                <ul className="divide-y divide-line">
                  {outgoing.map((friendship) => (
                    <FriendRow
                      key={friendship.id}
                      friendship={friendship}
                      subtitle="Waiting for them to accept"
                      onOpenProfile={openProfileCard}
                      actions={
                        <IconButton
                          label="Cancel request"
                          onClick={() => void remove(friendship, 'Cancelled the request to')}
                        >
                          <X size={17} className="text-danger" />
                        </IconButton>
                      }
                    />
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function FriendList({
  title,
  friendships,
  empty,
  onOpenDm,
  onRemove,
  onOpenProfile,
}: {
  title: string;
  friendships: Friendship[];
  empty: string;
  onOpenDm: (userId: string) => void;
  onRemove: (friendship: Friendship) => void;
  onOpenProfile: (card: { userId: string; anchor: { x: number; y: number } }) => void;
}) {
  const presence = useAppStore((s) => s.presence);

  if (friendships.length === 0) {
    return <EmptyState icon={<UserPlus size={40} />} title="Nothing here yet" body={empty} />;
  }

  return (
    <>
      <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-ink-faint">
        {title}
      </h3>
      <ul className="divide-y divide-line">
        {friendships.map((friendship) => (
          <FriendRow
            key={friendship.id}
            friendship={friendship}
            subtitle={
              presence[friendship.user.id]?.customStatus ??
              (presence[friendship.user.id]?.status ?? 'offline')
            }
            onOpenProfile={onOpenProfile}
            actions={
              <>
                <IconButton label="Message" onClick={() => onOpenDm(friendship.user.id)}>
                  <MessageSquare size={17} />
                </IconButton>
                <IconButton
                  label="Remove friend"
                  onClick={() => onRemove(friendship)}
                  tone="danger"
                >
                  <UserX size={17} />
                </IconButton>
              </>
            }
          />
        ))}
      </ul>
    </>
  );
}

function FriendRow({
  friendship,
  subtitle,
  actions,
  onOpenProfile,
}: {
  friendship: Friendship;
  subtitle: string;
  actions: React.ReactNode;
  onOpenProfile: (card: { userId: string; anchor: { x: number; y: number } }) => void;
}) {
  const status = useAppStore((s) => s.presence[friendship.user.id]?.status ?? 'offline');

  return (
    <li className="group/friend flex items-center gap-3 py-2.5">
      <button
        onClick={(event) =>
          onOpenProfile({
            userId: friendship.user.id,
            anchor: { x: event.clientX, y: event.clientY },
          })
        }
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Avatar
          userId={friendship.user.id}
          name={friendship.user.displayName}
          src={friendship.user.avatarUrl}
          size={36}
          status={status}
          showStatus
        />
        <span className="min-w-0">
          <span className="block truncate text-[15px] font-medium text-ink">
            {friendship.user.displayName}
            <span className="ml-1 text-[13px] font-normal text-ink-faint">
              #{friendship.user.discriminator}
            </span>
          </span>
          <span className="block truncate text-[13px] capitalize text-ink-faint">
            {subtitle}
          </span>
        </span>
      </button>
      <div className="flex shrink-0 items-center gap-1">{actions}</div>
    </li>
  );
}

/* -------------------------------------------------------------------------- */

function AddFriendPanel() {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: 'success' | 'error'; message: string } | null>(
    null,
  );
  const upsertFriendship = useAppStore((s) => s.upsertFriendship);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const username = value.trim();
    if (!username) return;

    setBusy(true);
    setResult(null);

    try {
      const response = await api.post<{ friendship: Friendship; accepted?: boolean }>(
        '/api/friends/requests',
        { username },
      );
      upsertFriendship(response.friendship);
      setResult({
        tone: 'success',
        message: response.accepted
          ? `You are now friends with ${response.friendship.user.displayName}.`
          : `Friend request sent to ${response.friendship.user.displayName}.`,
      });
      setValue('');
    } catch (error) {
      setResult({
        tone: 'error',
        message:
          error instanceof ApiClientError ? error.message : 'Could not send that request.',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-xl">
      <h2 className="text-[15px] font-semibold uppercase tracking-wide text-ink">Add friend</h2>
      <p className="mt-1 text-[14px] text-ink-dim">
        You can add someone with their username. If more than one person uses that name,
        include the tag — like <code className="rounded bg-surface-3 px-1">alex#0001</code>.
      </p>

      <form onSubmit={submit} className="mt-4 flex gap-2">
        <Input
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Enter a username"
          invalid={result?.tone === 'error'}
        />
        <Button type="submit" loading={busy} disabled={!value.trim()}>
          Send request
        </Button>
      </form>

      {result && (
        <p
          className={clsx(
            'mt-3 rounded-lg border px-3 py-2 text-[13px]',
            result.tone === 'success'
              ? 'border-online/40 bg-online/10 text-online'
              : 'border-danger/40 bg-danger/10 text-danger',
          )}
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
