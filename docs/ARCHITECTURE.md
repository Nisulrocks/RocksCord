# Architecture

This document covers the decisions that shaped the codebase. The reasoning for each is
also in a comment where it is implemented — this is the map, not a duplicate.

---

## The organising idea

**One server factory, three consumers.**

```ts
// apps/server/src/app.ts
export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp>
```

`buildApp()` takes its database as a parameter and holds no module-level state. Three very
different things use it:

| Consumer | How |
|---|---|
| `npm run dev` / `npm start` | `src/index.ts` binds a port |
| The test suite | Each file gets a private throwaway database |
| `RocksCord.exe` | The Electron main process boots it in-process |

The desktop app is therefore not a reimplementation of the server, and the tests are not
running against a mock. A bug fixed in one is fixed in all three.

This is also what makes tests fast and parallel: no shared global to reset between files.

---

## Data model

19 tables. The schema is in [`apps/server/src/db/schema.ts`](../apps/server/src/db/schema.ts),
annotated table by table.

```
users ──┬── sessions                      hashed refresh tokens, one row per device
        │
        ├── members ──── member_roles ──── roles ──┐
        │      │                                   │
        ├── servers ──── channels ──── channel_overwrites
        │                   │
        │                   ├── messages ──┬── message_mentions
        │                   │              ├── reactions
        │                   │              └── attachments
        │                   │
        │                   └── dm_participants
        │
        ├── friendships          one row per pair, ordered key
        ├── invites
        ├── read_states          per user per channel
        ├── notifications
        ├── bans
        └── audit_logs

messages_fts                     FTS5 external-content index over messages.content
```

### ULID primary keys

Every id is a 26-character ULID: a 48-bit millisecond timestamp followed by 80 bits of
randomness, in Crockford base32. Implementation: [`lib/ids.ts`](../apps/server/src/lib/ids.ts).

Two properties earn their keep:

**Lexicographic order equals chronological order.** So:

```sql
-- message pagination: a keyset scan on the primary key
SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT 50
```

No separate timestamp index, no `OFFSET` re-scanning the channel, and no skipped or
duplicated rows when someone posts mid-scroll. "Is this message newer than my last-read
one?" becomes a string comparison the client can do without asking the server.

**No coordination.** Ids can be minted anywhere without a round trip, which is what lets
the composer create an optimistic message before the server has seen it.

Generation is monotonic within a millisecond: the random component is incremented rather
than re-rolled, so two messages sent in the same millisecond still sort in send order.

### DMs are channels

A direct message is a `channels` row with `server_id = NULL`, plus rows in
`dm_participants`. It is not a separate table.

The payoff is that messages, attachments, reactions, read state, mentions, search,
pagination, and even voice work in DMs with **no special-casing** in any of those
subsystems. The only code that knows DMs exist is permission resolution, which has one
branch: in a DM, participation *is* the permission.

### Unread state is derived, not stored

Because ids sort chronologically, "this channel has unread messages" is:

```
channel.newestMessageId > readState.lastReadMessageId
```

No write happens when a message arrives. Only the **mention counter** is maintained
incrementally, because counting mentions on read would be a scan.

### Deletes are tombstones

Deleting a message sets `deleted = 1` and blanks the content. It does not remove the row.

Replies point at `reply_to_id`; a hard delete would either cascade the replies away or
leave dangling references. The tombstone lets a reply render "original message was
deleted" instead.

---

## Permissions

The bitfield and its resolver live in
[`packages/shared/src/permissions.ts`](../packages/shared/src/permissions.ts) — imported by
**both** the server and the client, so there is exactly one implementation.

22 permissions, all under bit 31 so plain JavaScript bitwise operators work without BigInt.

### Resolution order

1. Server owner → everything, stop.
2. Start from the `@everyone` role's permissions.
3. OR in every additional role the member holds.
4. If `ADMINISTRATOR` is set → everything, stop.
5. Apply channel overwrites, in this order:
   - the `@everyone` overwrite
   - role overwrites — denies collected, then allows (so a single allow anywhere beats a
     deny elsewhere)
   - the member-specific overwrite (most specific, wins outright)

### Client and server both use it — differently

The server calls it on **every mutating route** and rejects what fails. The client calls it
to decide what to grey out. Hiding a button is a courtesy; the server is the control.

Because it is the same function, a button is disabled under exactly the conditions that
would make the request fail. There is no second implementation to drift.

### Two guards that make it real

Both in [`routes/roles.ts`](../apps/server/src/routes/roles.ts) and
[`lib/permissions.ts`](../apps/server/src/lib/permissions.ts):

- **No escalation.** You cannot grant a permission you do not hold. Without it, anyone with
  `MANAGE_ROLES` could mint themselves an administrator role.
- **Hierarchy.** You cannot act on, or edit a role at or above, your own highest position.
  Without it, two moderators could kick each other in a loop.

### Private channels are actually private

A channel you cannot `VIEW_CHANNEL`:

- returns **404**, not 403 — its existence is not observable
- is absent from channel listings and the ready payload
- cannot be subscribed to over the socket
- **is excluded from message fan-out**

That last point was a real bug caught by
[`realtime.test.ts`](../apps/server/tests/realtime.test.ts). Messages are delivered twice:
to the channel room (people with it open) *and* to each member's personal room (so sidebars
light up). The second path originally used "all server members" and leaked private-channel
content. It now resolves visibility per member — see `membersWhoCanViewChannel()`.

---

## Authentication

[`lib/auth.ts`](../apps/server/src/lib/auth.ts) and
[`routes/auth.ts`](../apps/server/src/routes/auth.ts).

| Token | Lifetime | Storage | Revocable |
|---|---|---|---|
| Access | 15 min | Client memory only | No — hence short |
| Refresh | 30 days | `httpOnly` cookie; SHA-256 hash in the DB | Yes |

**Why the access token is never persisted.** Anything in `localStorage` is readable by any
script on the page, so one XSS would hand over a long-lived credential. Keeping it in a
module variable means it dies with the tab. The refresh token is in an `httpOnly` cookie
the page cannot read at all.

**Why the refresh token is hashed with SHA-256, not Argon2.** It is already 256 bits of
uniform randomness — there is no low-entropy guess space for a slow hash to defend. A fast
hash keeps the lookup index usable.

**Rotation and theft detection.** Redeeming a refresh token revokes it and issues a new
one. If a *revoked* token is presented, either an old tab raced a rotation or a stolen
token is being replayed. We cannot tell which, so we assume the worst and revoke every
session for that account. Covered by a test.

**Single-flight refresh on the client.** When an access token expires, several in-flight
requests 401 at once. Without coordination each would trigger its own refresh, and since
tokens rotate, the second would present an already-revoked token — which the server
correctly treats as theft and responds to by killing every session. So
[`lib/api.ts`](../apps/web/src/lib/api.ts) has all callers await one shared refresh promise.

**Account enumeration.** An unknown account and a wrong password return the same status and
the same message, and a dummy Argon2 hash is verified in the unknown-account path so the
response times match.

---

## Realtime

[`realtime/gateway.ts`](../apps/server/src/realtime/gateway.ts).

Socket.IO, chosen over raw `ws` for automatic long-polling fallback (the app still works
where WebSocket upgrades are blocked) and for rooms.

### Rooms are the authorisation model

```
user:<id>       every socket that user has open — targeted delivery
server:<id>     every member of a server
channel:<id>    everyone with that channel open
voice:<id>      everyone in that voice channel
```

If you are not in the room, the event is never serialised for you. Joining a channel room
is a permission check, not a formality.

### Handshake

The connection carries the same JWT the REST API uses. An unauthenticated socket is
rejected in middleware and never reaches a handler — there is no "connect first,
authenticate later" window.

Because the access token lasts 15 minutes, a reconnect after a long sleep would fail. The
client refreshes the token before every reconnection attempt, which is what makes closing
a laptop lid for an hour and reopening it just work.

### Presence is in memory, reference-counted

[`realtime/presence.ts`](../apps/server/src/realtime/presence.ts).

Who is online is inherently ephemeral, so it is not in the database — writing a row on
every connect and disconnect would be pure write amplification against a free-tier write
quota, and the data is worthless after a restart anyway.

A user can have several sockets (desktop + browser + phone). The registry counts them and
only reports offline when the **last** one goes. A restarted process has an empty map, so
everyone is offline — which is exactly true.

The cost: this is per-process state, so running two instances would split it. That is an
accepted limit, documented in the README.

---

## Voice

[`apps/web/src/lib/voice.ts`](../apps/web/src/lib/voice.ts).

A **full mesh**: every participant holds one `RTCPeerConnection` to every other and sends
their microphone directly to each. The server relays only the SDP offer/answer and ICE
candidates.

**This is why voice is free.** Media never touches the server, so there is no bandwidth
bill and no always-on media process. An SFU would need both.

The trade-off is explicit: with N people, each client uploads N−1 copies of its own audio.
Opus at ~32 kbit/s makes that comfortable to about 6–8 people. Past that you need an SFU,
which needs a paid server.

**Glare avoidance without extra signalling.** If both peers offered simultaneously,
negotiation would deadlock. The rule is deterministic: the peer with the lexicographically
smaller user id always makes the offer. Ids are unique, so exactly one side offers.

**Speaking detection** is real audio analysis — RMS of the time-domain samples from a Web
Audio `AnalyserNode`, with hysteresis so the ring does not flicker between words. It is not
derived from mute state.

The server still validates: a signal is only relayed if both parties are currently in the
same voice channel, so signalling cannot be used as an unmoderated side channel.

---

## Message rendering and XSS

[`components/chat/MessageContent.tsx`](../apps/web/src/components/chat/MessageContent.tsx).

Message content is **never** passed to `innerHTML` or `dangerouslySetInnerHTML`. It is
parsed into a token array and each token becomes a React element.

The distinction matters: injected markup renders as literal text because it is never
treated as markup, not because a sanitiser stripped it. There is no filter to bypass.

This is also why the server stores content verbatim — escaping on the way in would corrupt
legitimate text like `5 < 6` for no security benefit.

Mentions are stored as stable id tokens (`<@01H...>`) rather than names, so renaming a user
or channel does not break every message that mentioned it.

---

## Uploads

[`lib/filetype.ts`](../apps/server/src/lib/filetype.ts) and
[`routes/files.ts`](../apps/server/src/routes/files.ts).

The pipeline, in order:

1. multipart limits cap the stream at 8 MB before it is fully read
2. the byte count is re-checked after buffering (a limit can be hit mid-stream)
3. **the real type is sniffed from the leading bytes** — the declared `Content-Type` is
   attacker-controlled and never trusted
4. the sniffed type must be on the allow-list
5. the filename is stripped of directories, `..`, leading dots, and Windows device names
6. image dimensions are read so the client can reserve layout space
7. the object lands under a key carrying 96 bits of randomness

Text files have no magic bytes, so they are validated structurally: must decode as UTF-8,
no NUL bytes, no stray control characters.

Serving is defensive: `X-Content-Type-Options: nosniff`, a restrictive CSP, and
`Content-Disposition: attachment` for everything that is not an image, audio, or video.

**Attachments are uploaded before the message exists** and "claimed" when it is sent. That
is what lets the composer upload in the background while you are still typing. Claiming is
scoped to the uploader and to still-unclaimed rows, so you cannot attach someone else's
upload. Orphans are swept periodically.

---

## Storage abstraction

Two drivers behind one interface
([`lib/storage/`](../apps/server/src/lib/storage/)):

| Driver | Used for |
|---|---|
| `local` | Development and the desktop app — files stay on your machine |
| `supabase` | Production, because Render's free tier has no persistent disk |

Access control is a **capability URL**: keys embed 96 bits of randomness, so a link is
unguessable. Someone *given* the link can open it without being in the channel. This is the
same model image CDNs use; signing every URL would break plain `<img src>` rendering, which
is not a worthwhile trade here. The limitation is documented rather than hidden.

---

## Search

[`routes/search.ts`](../apps/server/src/routes/search.ts).

SQLite **FTS5**, as an *external content* table: it stores only the inverted index and
reads the text from `messages` via rowid, so message bodies are not duplicated. Three
triggers keep it in sync with inserts, edits, and deletes.

Ranking is BM25, with the message id as a tiebreak so equally relevant hits come back
newest-first.

**The security boundary comes first.** The candidate channel set is computed from the
caller's memberships and channel visibility *before* the query runs, so search can never
surface a message from a channel they cannot open.

FTS5 has its own query syntax where `"`, `*`, `:`, `-`, and `NEAR` are operators. Search
terms are escaped into quoted literal phrases, so typing `a" OR 1=1` finds nothing instead
of erroring or changing the query's meaning. If FTS5 is somehow unavailable, search
degrades to `LIKE` rather than breaking.

---

## Client state

One Zustand store ([`store/useAppStore.ts`](../apps/web/src/store/useAppStore.ts)) for
server state, because almost every realtime event touches several slices at once — a new
message updates the message list, unread state, DM ordering, and the notification tray.
Splitting those would mean coordinating writes across stores for every event.

Two smaller stores are separate for good reasons:

- **`useVoiceStore`** — the speaking indicator updates many times per second; every write
  would re-render anything subscribed to unrelated app state.
- **`useUiStore`** — modals, menus, toasts, and composer drafts are not server state.

### A subtle failure worth knowing about

Zustand compares selector results by reference. A selector written as:

```ts
useAppStore((s) => s.messagesByChannel[id] ?? [])   // ← new array every call
```

returns a **new array** on every call, so `useSyncExternalStore` sees the snapshot change
on every render and React loops until it throws *Maximum update depth exceeded*.

The fix is a single shared frozen empty array (`EMPTY_ARRAY` in the store), so the empty
case has a stable reference. This bit during development and is worth remembering.

---

## Scroll anchoring

[`hooks/useChannelMessages.ts`](../apps/web/src/hooks/useChannelMessages.ts).

When older messages are prepended, the browser keeps `scrollTop` the same — but the content
above the viewport just got taller, so the user appears to jump backwards. Fix: record
`scrollHeight` before the insert and add the delta afterwards.

Related: new messages only auto-scroll when the user is **already at the bottom**. Yanking
someone back down while they are reading history is the worst thing a chat client can do.

---

## The desktop app

[`apps/desktop/src/main.ts`](../apps/desktop/src/main.ts).

The Electron main process imports `buildApp()` and runs the server in-process. One binary,
no child process to spawn or supervise, works offline.

**Environment before import.** The server reads its configuration at import time, so
`main.ts` sets `DATABASE_URL`, `UPLOAD_DIR`, and `JWT_SECRET` and *then* uses a dynamic
`import()`. A static import would be hoisted above those assignments.

**The signing key is persisted** in `config.json`. Without that, every launch would
generate a new secret and silently sign you out — which looks exactly like a bug.

**Second windows use separate session partitions**, which is what makes signing in as two
different users inside one app possible. Ordinary windows share a cookie jar.

### Two packaging findings

Both cost real debugging time and are recorded so they are not rediscovered:

1. **electron-builder's `portable` target never reaches an ESM entry point.** The process
   starts, sits at ~70 MB, and does nothing — no error, no log. The `win-unpacked` build of
   the *same* asar worked fine. The bundle is therefore emitted as CommonJS, with
   `import.meta.url` rewritten to a `__filename`-derived URL. Since the whole server is in
   one bundled file, the module format is an implementation detail.

2. **A module that runs a script on import is a landmine once bundled.** `migrate.ts` had a
   "was I run directly?" check comparing `import.meta.url` to `process.argv[1]`. In a
   bundle both point at the bundle, so the check fired and started a second migration
   racing the app's own — surfacing as `table 'attachments' already exists` on a brand-new
   database. CLI entry points now live in their own files (`migrate-cli.ts`, `seed-cli.ts`)
   that are never imported.

---

## Testing

Each test file opens its **own throwaway database file** in the OS temp directory, so files
run in parallel with no shared state.

Not `:memory:`, deliberately: `@libsql/client` gives every *connection* its own private
in-memory database, and Drizzle's `db.transaction()` opens a second connection — so under
`:memory:` any transaction runs against an empty schema and fails with "no such table".
A throwaway file behaves exactly like production and costs milliseconds. `:memory:` is
rejected in `env.ts` with an explanation rather than left as a trap.

See [TESTING.md](TESTING.md).
