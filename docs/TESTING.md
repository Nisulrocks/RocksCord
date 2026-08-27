# Testing RocksCord

Three layers, from fastest to most realistic:

| Layer | Command | What it proves |
|---|---|---|
| Automated suite | `npm test` | 130 tests: auth, permissions, messaging, realtime, uploads, pure logic |
| Smoke test | `npm run smoke` | Two users actually exchange a live message over a running server |
| Manual checklist | below | The parts a human has to look at — UI, voice, notifications |

---

## 1. Automated tests

```bash
npm test
```

Expect `Test Files 6 passed (6)` and `Tests 130 passed (130)` in about ten seconds.

Each test file gets its own throwaway SQLite file in the OS temp directory, so the suite
is safe to run repeatedly and never touches your development database.

| File | Covers |
|---|---|
| `auth.test.ts` | registration, login, argon2 hashing, refresh-token rotation, stolen-token detection, password change |
| `permissions.test.ts` | role hierarchy, privilege escalation, channel overwrites, kicks, bans |
| `messages.test.ts` | send/edit/delete, replies, reactions, mentions, keyset pagination, DMs, search |
| `realtime.test.ts` | socket handshake auth, live delivery, typing, presence reference-counting, voice signalling |
| `uploads.test.ts` | content sniffing, disguised payloads, size limits, filename traversal, attachment ownership |
| `units.test.ts` | ULID sortability, permission bitfields, mention parsing, input normalisation |

Watch mode while developing:

```bash
npm run test:watch
```

### Tests worth reading

A few encode decisions rather than just behaviour:

- **`auth.test.ts` → "revokes every session when a used refresh token is replayed"** — proves
  the token-theft response works: replaying a rotated token kills the whole session family.
- **`permissions.test.ts` → "stops someone with MANAGE_ROLES granting a permission they lack"** —
  the escalation guard. Without it, any admin could mint themselves an ADMINISTRATOR role.
- **`realtime.test.ts` → "does not leak messages from a channel the user cannot view"** — this
  one caught a real bug during development: messages were being pushed to every server
  member's socket for sidebar badges, ignoring channel visibility.
- **`uploads.test.ts` → "rejects an HTML payload disguised as a PNG"** — the upload pipeline
  trusts the file's bytes, never its declared `Content-Type`.

---

## 2. Smoke test

With the server already running (`npm run dev`):

```bash
npm run smoke
```

This logs in as two seeded users, opens two WebSocket connections, sends a message as one,
and asserts the other receives it live — plus typing indicators, presence, edit propagation,
and that permissions are actually enforced.

Point it at any deployment:

```bash
npm run smoke -- https://your-app.onrender.com
```

It needs the seeded accounts, so run `npm run db:seed` first on a fresh database.

---

## 3. Testing with multiple users

**The one thing to know:** the refresh token lives in an `httpOnly` cookie, so two normal
tabs in the same browser share one session — signing in as a second user in tab 2 signs
tab 1 in as that user too. You need separate cookie jars.

### Option A — private windows (easiest)

| Window | How |
|---|---|
| User A | Normal window → `http://localhost:5173` |
| User B | Ctrl+Shift+N (Chrome/Edge private window) |
| User C | A different browser entirely (Firefox) |

Each has its own cookie jar, so all three stay signed in independently.

### Option B — the desktop app

`RocksCord.exe` has this built in. **File → Open a second window** (Ctrl+Shift+N) opens
a window with an isolated session partition, so you can be two different users inside one
app. Repeat for a third.

### Option C — a browser pointed at the desktop app

The desktop app writes its address to:

```
%APPDATA%\RocksCord\server-url.txt
```

Open that URL in any browser to sign in as another user against the same embedded server.

### Option D — a shared server (what your friends will actually use)

Point every copy at one server, then each person just signs in normally. See
[SHARING.md](SHARING.md). This is the only option where people on *different machines*
can see each other.

### Option E — another device on your network

1. Find this machine's LAN IP: `ipconfig` → the IPv4 address, e.g. `192.168.1.42`
2. Make sure the server binds all interfaces (it does by default: `HOST=0.0.0.0`)
3. On the phone or laptop, open `http://192.168.1.42:5173`
4. Allow Node.js through Windows Firewall if prompted

Voice works between devices on the same LAN without any TURN server.

---

## 4. Manual checklist

Work top to bottom. Everything here should pass on a freshly seeded database.

### Accounts

- [ ] Register a new account — you get a `#0000`-style tag automatically
- [ ] Registering the same email twice is rejected with a clear message
- [ ] A password under 8 characters is rejected inline, before submitting
- [ ] Sign out, then sign back in
- [ ] Refresh the page while signed in — you stay signed in
- [ ] Sign in with username instead of email

### Status

- [ ] User panel → **Change your status** → Idle: the dot changes immediately
- [ ] Settings → Profile → **Do not disturb**: the dot changes immediately, with **no
      need to press Save**
- [ ] Both places agree, and survive a reload
- [ ] With an account that has joined **no servers at all**, both still work — this used
      to broadcast to an empty audience and appear to do nothing
- [ ] With two windows signed in as the same account, changing status in one updates the
      other
- [ ] Settings → Account → change password; other sessions are signed out

### Email verification

Only applies when a provider is configured. To exercise it locally without one, start the
server with `REQUIRE_EMAIL_VERIFICATION=true` and copy links out of the terminal:

```bash
REQUIRE_EMAIL_VERIFICATION=true npm start
```

- [ ] Register — you land on "Check your inbox", **not** in the app
- [ ] The email arrives (or the link is printed to the server log)
- [ ] Trying to sign in before confirming shows "Confirm your email to continue"
- [ ] Signing in with the **wrong** password on that account says invalid credentials, not
      unverified — the address must not leak to someone who does not know the password
- [ ] The resend button is disabled for 60 seconds, then works
- [ ] Clicking the link shows a confirmation page
- [ ] You can now sign in
- [ ] Clicking the same link again says "already confirmed" rather than showing an error
- [ ] Editing a character out of the link gives "that link is not valid"
- [ ] Requesting a resend, then using the **older** link, is rejected

### Quick switcher

- [ ] `Ctrl`+`K` (or `Cmd`+`K`) opens it from anywhere, including while typing a message
- [ ] It does **not** open the browser's address bar
- [ ] Typing filters by fuzzy match — `gnrl` finds `general`
- [ ] Typing a server name narrows to that server's channels
- [ ] Arrow keys move the highlight; Enter jumps; Escape closes
- [ ] Hovering a row moves the highlight, so mouse and keyboard do not fight
- [ ] `Ctrl`+`K` again closes it

### Auto-idle

- [ ] Set yourself **Online**, leave the app untouched for five minutes — you go **Idle**
- [ ] Move the mouse — you go back to **Online**
- [ ] Set yourself **Do not disturb**, wait five minutes — you stay **Do not disturb**
- [ ] Set yourself **Idle** by hand, then move the mouse — you stay **Idle**, because you
      chose it
- [ ] A second window signed in as the same account sees the change

### Deleting an account

Use a throwaway account.

- [ ] Settings → Account → **Delete my account** asks for your password
- [ ] A wrong password is refused and nothing happens
- [ ] Owning a server that someone else has joined blocks it, and names the server
- [ ] Owning a server nobody else joined is fine; that server is deleted with the account
- [ ] After deleting: you land on the sign-in screen and cannot sign back in
- [ ] Messages you sent still appear to others, attributed to **Deleted User**
- [ ] The account no longer appears in user search or accepts friend requests
- [ ] A second window still signed in as that account is kicked out

### Servers and channels

- [ ] Create a server — it gets `#general`, a voice channel, and Admin/Moderator roles
- [ ] Create a text channel; the name preview slugifies as you type (`My Cool` → `my-cool`)
- [ ] Create a voice channel — the name keeps its capitals
- [ ] Rename a channel and set a topic; the topic shows in the header
- [ ] Delete a channel
- [ ] Deleting the *last* text channel is refused
- [ ] Upload a server icon

### Messaging

- [ ] Send a message; it appears instantly
- [ ] Send from user B — user A sees it **without refreshing**
- [ ] Edit a message; an `(edited)` marker appears for both users
- [ ] Delete a message; it becomes "This message was deleted."
- [ ] Reply to a message; the reply preview shows above it
- [ ] Delete the original — the reply still renders with a tombstone
- [ ] React with an emoji; the count increments for both users
- [ ] Click your own reaction to remove it
- [ ] Type `**bold**`, `` `code` ``, `~~strike~~`, `||spoiler||` — all render
- [ ] Send only emoji — they render large
- [ ] Send `<script>alert(1)</script>` — it shows as literal text, no dialog
- [ ] Scroll up to load older messages; your scroll position does not jump
- [ ] Scroll up, then have B send a message — you are **not** yanked to the bottom
- [ ] "Jump to latest" appears when scrolled up

### Mentions and notifications

- [ ] Type `@` — the member picker opens; arrow keys and Enter select
- [ ] Mention user B — B sees a red badge on the channel and server
- [ ] Opening the channel clears the badge
- [ ] `@everyone` as the owner pings everyone; as a plain member it does not
- [ ] A message in an unread channel shows a white dot in the sidebar

### Direct messages and friends

- [ ] Friends → Add friend → send a request by username
- [ ] User B sees it under Pending with a badge
- [ ] Accept it; both appear in each other's friends list
- [ ] Message a friend; the DM appears in both sidebars
- [ ] The DM sorts to the top of the list on each new message
- [ ] Remove a friend

### Presence and typing

- [ ] Sign in as B — A sees B turn green in the member list
- [ ] Close B's window — A sees B go grey within a few seconds
- [ ] Start typing as B — A sees "B is typing…" with animated dots
- [ ] Stop typing — the indicator disappears after ~8 seconds
- [ ] Change status to Idle/Do Not Disturb — the dot colour changes for everyone

### Permissions

- [ ] As owner: Server Settings → Roles → create a role, give it a colour
- [ ] Assign it to a member; their name is tinted in the member list
- [ ] Enable "Display separately" — they get their own member-list group
- [ ] As a plain member, try to delete someone else's message — refused
- [ ] Give them Moderator, try again — it works
- [ ] Channel Settings → Permissions → deny `View channel` to @everyone
- [ ] The plain member can no longer see the channel at all
- [ ] Allow it for one role — only that role sees it again
- [ ] As a Moderator, try to edit the Admin role — refused with an explanation
- [ ] Kick a member; they lose access immediately
- [ ] Ban a member; a fresh invite does not let them back in

### Files

- [ ] Upload a PNG — it renders inline at the right size, with no layout jump
- [ ] Click it — the full-size viewer opens; Escape closes it
- [ ] Upload a PDF — it shows as a download card, not inline
- [ ] Drag a file onto the composer — the drop zone highlights
- [ ] Paste an image from the clipboard
- [ ] Rename a `.txt` to `.png` and upload it — rejected as the wrong type
- [ ] Upload something over 8 MB — rejected with a size message
- [ ] Set your avatar in Settings → Profile

### Search

- [ ] Search a word you know is in a message — it is found
- [ ] "This channel only" narrows the results
- [ ] Search for a user by username
- [ ] Search from an account that shares no channels — no results leak

### Voice

Needs two users. Use two private windows, or two desktop windows.

- [ ] Click a voice channel — you connect; your avatar appears under it
- [ ] User B joins — both see each other in the channel and on the voice stage
- [ ] **Talk — the other person hears you**
- [ ] Your avatar gets a green ring while you speak
- [ ] Mute — the mic icon turns red, the other person stops hearing you
- [ ] Deafen — you hear nothing, and it mutes you too
- [ ] Undeafen restores both
- [ ] Share your screen — B sees a LIVE badge and can watch it
- [ ] Stop sharing from the browser's own bar — the app updates
- [ ] Disconnect — you disappear from the channel for everyone

### Audio settings

Settings → Voice. The first four need no second user.

- [ ] Device names are hidden until you click **Show device names**, then appear
- [ ] **Test microphone** — the meter moves when you speak, and the top segments turn amber
      when you are close to clipping
- [ ] The line under the meter names the device actually opened; it matches the dropdown
- [ ] Switch microphone mid-test — the meter restarts, and the named device changes
- [ ] With two microphones, pick the one you are *not* speaking into: the meter stays flat.
      That is the check that the selection is honoured rather than ignored
- [ ] **Hear myself** (headphones on) — you hear your own voice, on the chosen output
- [ ] Untick it — monitoring stops but the meter keeps moving
- [ ] Pick a microphone, unplug it, then start the test — it says the device is no longer
      available rather than silently testing a different one
- [ ] Output volume and the processing toggles survive a full page reload
- [ ] While in a call with B, change your microphone — **B keeps hearing you**, with no
      disconnect and no gap
- [ ] While in a call, toggle noise suppression — the call survives the microphone reopening
- [ ] Drop output volume to 0 — B's voice goes silent while they stay connected
- [ ] Where the browser has no `setSinkId` (Firefox), the output picker is disabled with an
      explanation rather than silently doing nothing

### Appearance

- [ ] Settings → Appearance → **Light** — the whole app inverts immediately
- [ ] Reload — it comes back light, with **no dark flash** before the first paint
- [ ] **System** follows the OS setting; change the OS theme and the app follows live
- [ ] In light mode, text stays readable everywhere: chat, sidebar, rail, modals, menus,
      the member list, and the message composer
- [ ] Scrollbars and form controls adopt the light scheme rather than staying dark

### Interface

- [ ] Right-click a message, a channel, a server, a member — context menus appear
- [ ] Click an avatar — the profile card opens, positioned on-screen
- [ ] Escape closes modals, menus, and the profile card
- [ ] Tab through a modal — focus stays inside it
- [ ] Narrow the window below 768px — it collapses to one pane at a time
- [ ] Stop the server — an amber "Reconnecting…" bar appears
- [ ] Start it again — the bar disappears and messages flow again

### The executable

- [ ] Double-click `RocksCord.exe`; the window opens within ~10 seconds
- [ ] Register an account inside it
- [ ] File → Open a second window; register a different account there
- [ ] Send messages between the two windows in real time
- [ ] Help → About shows the version, data folder, and log path
- [ ] Close and reopen — you are still signed in, and messages are still there

---

## Resetting

```bash
npm run db:reset
```

Deletes the local database and uploads, re-applies migrations, and re-seeds. It refuses to
run against a remote Turso database.

For the desktop app, delete `%APPDATA%\RocksCord` instead.

---

## When something breaks

| Where | What to look at |
|---|---|
| Dev server | The terminal running `npm run dev` |
| Web client | Browser DevTools → Console and Network |
| Realtime | DevTools → Network → WS → the `socket.io` connection → Messages |
| Desktop app | `%APPDATA%\RocksCord\desktop.log` |
| Database | `npm run db:studio -w @rockscord/server` opens a table browser |
