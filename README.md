<div align="center">

<img src="assets/icon-source.png" width="120" alt="RocksCord" />

# RocksCord

**A real-time chat, voice, and community platform.**
Text channels, direct messages, roles and permissions, file sharing, full-text search,
and peer-to-peer voice with screen sharing.

Runs on your machine, ships as a Windows executable, and deploys to free hosting.
**Total cost to build, run, and host: $0.**

</div>

---

## Contents

- [What this is](#what-this-is)
- [Quick start](#quick-start)
- [Sharing it with friends](#sharing-it-with-friends)
- [Screens and features](#screens-and-features)
- [Architecture](#architecture)
- [Technology choices, and why](#technology-choices-and-why)
- [The $0 constraint](#the-0-constraint)
- [Project layout](#project-layout)
- [Database](#database)
- [Environment variables](#environment-variables)
- [Running locally](#running-locally)
- [Testing with multiple users](#testing-with-multiple-users)
- [Testing](#testing)
- [Changing the app icon](#changing-the-app-icon)
- [Building the Windows executable](#building-the-windows-executable)
- [Deploying for free](#deploying-for-free)
- [Security](#security)
- [Known limitations](#known-limitations)
- [Future improvements](#future-improvements)

---

## What this is

A working communication platform, not a UI mock. Multiple people connect at once and talk
in real time; messages, presence, typing indicators, and voice state all propagate over
WebSockets. Permissions are enforced on the server, uploads are content-sniffed, and
passwords are hashed with Argon2id.

It is a portfolio project, so the interesting parts are the decisions rather than the
feature list: why SQLite instead of Postgres, why the message ids are ULIDs, why voice is
a peer-to-peer mesh, why the desktop app embeds the server rather than shipping a second
one. Those are explained where they are implemented, and summarised below.

The visual identity is its own — violet and teal over cool near-blacks — and uses no
Discord branding, artwork, or assets.

---

## Quick start

Requires **Node.js 20 or newer** ([nodejs.org](https://nodejs.org)). Nothing else — no
database server, no Docker, no accounts.

```bash
npm run setup
npm run dev
```

Then open **http://localhost:5173**.

On Windows you can double-click `setup.bat` and then `run.bat` instead.

Setup installs dependencies, generates a `.env` with a signing key, applies migrations,
and seeds demo data. It is idempotent — run it again any time.

**Demo accounts** (password `password123` for all three):

| Email | Role in the demo server |
|---|---|
| `alex@rockscord.test` | Owner |
| `nova@rockscord.test` | Moderator |
| `kit@rockscord.test` | Member |

They are seeded into a server with channels, message history, a friendship, and a DM
thread, so there is something to look at immediately.

---

## Sharing it with friends

**Read this before you send the exe to anyone.**

By default the executable runs its own private server on your machine. Hand that exe to a
friend and they get *their own* private server and *their own* database — you would not
see each other at all.

To chat together, everyone connects to **one shared server**. Bake its address into the
build and your friends do nothing but double-click:

```bash
npm run build:exe -- --server=https://your-app.onrender.com
```

That address is compiled into the executable. No picker, no typing, no instructions —
they open it, register, and they are in.

Setting up that server is free and takes about 20 minutes (Turso for the database, Render
for hosting, neither needs a credit card). **[docs/SHARING.md](docs/SHARING.md)** walks
through it step by step, including a 5-minute Wi-Fi-only option for testing today.

Built without `--server`, the app asks once which server to use, and offers a local-only
mode. You can change it later from **File → Connect to a different server…**

---

## Screens and features

**Accounts** — registration, login, logout, argon2id password hashing, rotating refresh
tokens, avatars, custom status, online / idle / do-not-disturb / invisible presence.

**Servers** — create, delete, transfer ownership, icons, descriptions, invite links with
expiry and use limits, kicks, bans, and an audit log.

**Channels** — text and voice, create / rename / delete / reorder, topics, and per-role
and per-member permission overwrites with inherit / allow / deny.

**Messaging** — real-time delivery, editing, deleting, threaded replies with previews,
emoji reactions, mentions of users and roles and `@everyone`, pinning, an emoji picker,
markdown-style formatting, and keyset pagination for history.

**Direct messages** — one-to-one conversations that reuse the entire channel system,
ordered by recency, hideable without losing history.

**Friends** — requests, accept and reject, remove, block, with live updates on both sides.

**Roles and permissions** — a 22-permission bitfield, role hierarchy, colours, hoisting,
mentionable roles, and channel overwrites. Enforced server-side on every route; the client
uses the same resolver to grey out what you cannot do.

**Files** — drag, paste, or pick. Images render inline with reserved layout space, other
types become download cards. Content is sniffed from the file's bytes.

**Search** — SQLite FTS5 full-text search over messages, scoped to channels you can see,
plus user and channel search.

**Voice** — peer-to-peer WebRTC audio, mute, deafen, real-time speaking detection from
audio analysis, screen sharing, and per-peer volume.

**Notifications** — unread dots, mention badges, a notification tray, and OS notifications
when the window is not focused.

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  Clients                                                              │
│                                                                       │
│   Browser (React SPA)          RocksCord.exe (Electron)            │
│        │                              │                               │
│        │                              └── embeds the server ──┐       │
│        │                                                      │       │
│        │  HTTPS + WebSocket                                   │       │
└────────┼──────────────────────────────────────────────────────┼───────┘
         │                                                      │
         ▼                                                      ▼
┌───────────────────────────────────────────────────────────────────────┐
│  Server — Fastify + Socket.IO (one process)                           │
│                                                                       │
│   REST API            Realtime gateway         Static files           │
│   /api/*              rooms, presence,         built client           │
│   auth, servers,      typing, voice            + uploads              │
│   channels, messages  signalling                                      │
│                                                                       │
│   Permission resolution · rate limiting · content sniffing            │
└───────────────────────────────────────────────────────────────────────┘
         │                          │                        │
         ▼                          ▼                        ▼
┌─────────────────┐    ┌────────────────────┐   ┌──────────────────────┐
│ SQLite / Turso  │    │  Local disk or     │   │  Peers, directly     │
│ 19 tables + FTS │    │  Supabase Storage  │   │  WebRTC audio/video  │
└─────────────────┘    └────────────────────┘   └──────────────────────┘
```

Three properties are worth calling out.

**One server factory, three consumers.** `buildApp()` takes its database as a parameter
and holds no module-level state. `npm run dev` uses it, the test suite uses it against
throwaway databases, and the Electron main process uses it in-process. The desktop app is
not a reimplementation — it is the same server.

**Voice never touches the server.** Audio flows directly between browsers over WebRTC. The
server only relays the SDP handshake. This is why voice costs nothing to operate, and it
is the single biggest reason the whole project can be free.

**One SQL dialect everywhere.** Local development, the packaged desktop app, the test
suite, and production all speak SQLite. There is one schema and one set of migrations.

More detail, including the full data model, is in **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)**.

---

## Technology choices, and why

| Layer | Choice | Why this and not the obvious alternative |
|---|---|---|
| **Database** | SQLite locally → [Turso](https://turso.tech) in production | Turso is libSQL, which *is* SQLite: local development uses a plain file with zero install, production uses the same dialect and the same migrations. Postgres (Neon, Supabase) would mean either installing Postgres locally or being online to develop. Turso's free tier needs no credit card and does not expire. |
| **ORM** | [Drizzle](https://orm.drizzle.team) | Compiles to plain SQL with no query engine binary and no codegen step. Prisma ships a ~40 MB Rust engine and cannot switch providers from one schema, which would have broken the local-file/hosted split. |
| **Server** | [Fastify 5](https://fastify.dev) | Roughly twice Express's throughput, first-party schema validation, and plugin encapsulation that makes each route file genuinely independent. |
| **Realtime** | [Socket.IO 4](https://socket.io) | Automatic fallback to HTTP long-polling, so the app still works on hosts and networks that block WebSocket upgrades. Rooms give per-channel fan-out for free. Raw `ws` would mean hand-writing reconnection, acknowledgements, and room management. |
| **Client** | React 19 + [Vite](https://vite.dev) + [Tailwind 4](https://tailwindcss.com) + [Zustand](https://zustand.docs.pmnd.rs) | Zustand over Redux because the socket layer pushes into the store imperatively from outside React; that is awkward with Redux's action pipeline and natural with a plain store. |
| **Voice** | WebRTC mesh + Google STUN | Genuinely free — media is peer-to-peer. An SFU (LiveKit, mediasoup) would need an always-on server with real bandwidth. The trade-off is a practical ceiling of ~6–8 people per channel. |
| **Auth** | Own Argon2id + JWT | No vendor lock-in, no free-tier ceiling, and it is the part a reviewer actually wants to see implemented. Firebase or Auth0 would hide the interesting work behind an SDK. |
| **Files** | Local disk → Supabase Storage | Render's free tier has no persistent disk, so production needs external storage. Supabase gives 1 GB free with no card. |
| **Desktop** | [Electron](https://electronjs.org) + electron-builder | The server runs *inside* the Electron main process, so there is one binary, no child process, and it works offline. Tauri would be smaller but requires installing the Rust toolchain to build. |

---

## The $0 constraint

Everything below is free indefinitely, not a trial.

| Need | Service | Free tier | Credit card |
|---|---|---|---|
| Hosting | [Render](https://render.com) | 750 instance-hours/month, WebSockets supported | **No** |
| Database | [Turso](https://turso.tech) | 5 GB, 500M row reads/month, 100 databases | **No** |
| File storage | [Supabase Storage](https://supabase.com) | 1 GB storage, 5 GB egress/month | **No** |
| Voice | WebRTC peer-to-peer + Google STUN | Unlimited — no server involved | **No** |
| TURN relay *(optional)* | [Open Relay](https://www.metered.ca/tools/openrelay/) | 20 GB/month | No |
| Source hosting & CI | GitHub | Unlimited public repos, 2,000 Actions minutes | **No** |

**Running it locally costs nothing at all** — no accounts, no services, no internet. The
desktop executable is entirely self-contained.

A note on honesty: Render's free tier **sleeps after 15 minutes of inactivity** and takes
around 50 seconds to wake. That is fine for a portfolio demo and unpleasant for real
users. If you ever want always-on, [Northflank](https://northflank.com)'s Sandbox tier
gives two always-on services free, or a $5/month Render instance removes the sleep.

---

## Project layout

```
DiscordClone/
├── packages/shared/          Types, permission logic, validation, socket contracts
│   └── src/
│       ├── permissions.ts    The bitfield and its resolver — used by BOTH sides
│       ├── events.ts         Typed Socket.IO event contract
│       ├── validation.ts     Zod schemas shared by the API and the forms
│       └── mentions.ts       Mention encoding and tokenising
│
├── apps/server/              Fastify API + Socket.IO gateway
│   ├── src/
│   │   ├── app.ts            buildApp() — used by dev, tests, and the desktop app
│   │   ├── db/schema.ts      19 tables, documented
│   │   ├── lib/              auth, permissions, storage, serializers, sniffing
│   │   ├── routes/           one file per resource
│   │   └── realtime/         gateway, presence, voice state
│   ├── drizzle/              Generated SQL migrations (checked in)
│   └── tests/                130 tests
│
├── apps/web/                 React client
│   └── src/
│       ├── components/       layout, chat, voice, modals, ui primitives
│       ├── store/            Zustand stores
│       ├── hooks/            auth, messages, permissions, voice session
│       └── lib/              api client, socket, WebRTC mesh
│
├── apps/desktop/             Electron shell
│   └── src/main.ts           Boots the server in-process, opens the window
│
├── scripts/                  setup, desktop staging, exe build, icons, smoke test
└── docs/                     ARCHITECTURE.md, TESTING.md, DEPLOYMENT.md, EMAIL.md, SHARING.md
```

---

## Database

19 tables. The full schema with commentary is in
[`apps/server/src/db/schema.ts`](apps/server/src/db/schema.ts) and explained in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
users ──┬── sessions                    refresh tokens (hashed)
        ├── members ──── member_roles ──── roles
        ├── servers ──── channels ──── channel_overwrites
        │                    │
        │                    ├── messages ──┬── message_mentions
        │                    │              ├── reactions
        │                    │              └── attachments
        │                    └── dm_participants
        ├── friendships
        ├── invites
        ├── read_states
        ├── notifications
        ├── bans
        └── audit_logs

messages_fts                            FTS5 index over message content
```

Two design decisions shape most of the rest:

**Primary keys are ULIDs.** 26-character, time-ordered, lexicographically sortable. Because
sorting by id *is* sorting by time, message pagination is a keyset scan on the primary key
(`WHERE id < ? ORDER BY id DESC`), with no separate timestamp index and no `OFFSET`. Unread
state is a string comparison the client can do locally.

**DMs are channels.** A direct message is a `channels` row with `server_id = NULL` plus rows
in `dm_participants`. Messages, attachments, read state, search, and even voice therefore
work in DMs without a single special case in those subsystems.

### Commands

```bash
npm run db:migrate      # apply pending migrations (also runs automatically on boot)
npm run db:seed         # add demo accounts and a demo server
npm run db:reset        # delete the local database and uploads, then migrate + seed
npm run db:generate     # regenerate migrations after editing schema.ts
npm run db:studio -w @rockscord/server   # browse the data in a GUI
```

Migrations run automatically at startup, so pulling changes and restarting is enough.

---

## Environment variables

**You do not need a `.env` file to run this.** Every setting has a working default, and
`npm run setup` writes one for you. [`.env.example`](.env.example) documents all of them;
these are the ones that matter.

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | API port |
| `HOST` | `0.0.0.0` | `0.0.0.0` allows other devices on your LAN to connect |
| `DATABASE_URL` | `./data/rockscord.db` | Blank for local SQLite, or a `libsql://` Turso URL |
| `DATABASE_AUTH_TOKEN` | — | Only for Turso |
| `JWT_SECRET` | generated | Signs access tokens. **Required in production** — the server refuses to start without it |
| `PUBLIC_URL` | derived | Absolute base URL, used to build attachment links |
| `STORAGE_DRIVER` | `local` | `local` or `supabase` |
| `SERVE_CLIENT` | `true` | Serve the built client from the API process |
| `COOKIE_SECURE` | `false` | Set `true` behind HTTPS |
| `CORS_ORIGIN` | `*` | Comma-separated allowed origins |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close signups |
| `SMTP_HOST` / `SMTP_USER` / `SMTP_PASSWORD` | — | Any SMTP relay. Setting these turns email verification on |
| `EMAIL_API_KEY` | — | Alternative to SMTP: a Brevo (`xkeysib-…`) or Resend (`re_…`) key |
| `EMAIL_FROM` | `SMTP_USER` | Sender address the provider will accept |
| `REQUIRE_EMAIL_VERIFICATION` | inferred | Follows whether mail can be delivered; set to override |
| `TURN_URL` | — | Optional TURN relay for restrictive networks |

---

## Running locally

```bash
npm run dev
```

Starts the API on **:4000** and the Vite dev server on **:5173** with hot reload. Vite
proxies `/api`, `/uploads`, and `/socket.io` to the API, so the browser stays on one
origin and cookies behave exactly as they do in production.

Open **http://localhost:5173**.

### Running the pieces separately

```bash
npm run dev:server      # API only, on :4000
npm run dev:web         # client only, on :5173
```

### Production mode locally

```bash
npm run build
npm start
```

Serves the built client from the API on **http://localhost:4000** — one process, one port,
exactly as it runs when deployed.

---

## Testing with multiple users

**Read this first:** the refresh token is in an `httpOnly` cookie, so two ordinary tabs in
the same browser share one session. Signing in as a second user in tab 2 will also change
who tab 1 is. You need separate cookie jars.

| Approach | How |
|---|---|
| **Private windows** *(easiest)* | User A in a normal window, user B in a private window (Ctrl+Shift+N), user C in a different browser |
| **Desktop app** | **File → Open a second window** (Ctrl+Shift+N) — each window gets its own session partition |
| **Browser + desktop app** | The desktop app writes its address to `%APPDATA%\RocksCord\server-url.txt`; open it in a browser |
| **Another device** | Find your LAN IP with `ipconfig`, then open `http://<your-ip>:5173` on a phone or laptop |

### Watching real-time work

1. Put two windows side by side, signed in as different users, in the same channel.
2. Type in one — **"… is typing"** appears in the other within a second.
3. Send it — it appears in the other window with no refresh.
4. Edit it — both update. Delete it — both show the tombstone.
5. Close one window — the other shows that user go offline within a few seconds.
6. Join a voice channel in both — you can talk, and speaking rings light up as you do.

To see the wire protocol: DevTools → Network → **WS** → the `socket.io` connection →
Messages.

---

## Testing

```bash
npm test          # 130 automated tests, ~10 seconds
npm run smoke     # end-to-end check against a running server
```

Full strategy, what each suite covers, and a manual checklist:
**[docs/TESTING.md](docs/TESTING.md)**.

---

## Changing the app icon

The whole visual identity comes from one file:

```
assets/icon-source.png
```

Replace it with any square PNG and run:

```bash
npm run icons
```

That regenerates the Electron window and installer icon, the browser favicons, and the
in-app brand mark. Rebuild the exe afterwards to pick up the new icon.

The resizing is done by `scripts/prepare-icons.mjs`, which decodes and re-encodes PNG with
Node's built-in zlib rather than pulling in an image library for one build-time task.

---

## Building the Windows executable

```bash
npm run build:exe
```

Or double-click `build-exe.bat`. Takes a few minutes the first time while the Electron
runtime downloads and caches.

Output, in `apps/desktop/release/`:

| File | Size | What it is |
|---|---|---|
| **`RocksCord-Setup-1.0.0.exe`** | ~99 MB | **Installer — branded wizard, shortcuts, uninstaller. The one to send people.** |
| `RocksCord.exe` | ~99 MB | Portable — double-click to run, nothing installed |
| `win-unpacked/` | ~250 MB | Unpacked folder; copy it anywhere and run `RocksCord.exe` |

### The installer

`RocksCord-Setup-1.0.0.exe` is a normal NSIS wizard: a branded welcome page, a choice of
install location, a progress page, and a finish page offering to launch. It installs
**per-user**, which is what avoids a UAC prompt — most people receiving this will not have
an administrator account, and a shield prompt on an unsigned installer is the moment they
give up on it.

The sidebar and header artwork are generated from the app icon by `npm run icons`. They
have to be BMP at fixed sizes (164x314 and 150x57); NSIS reads nothing else for those
slots.

Uninstalling leaves `%APPDATA%\RocksCord` alone, so reinstalling keeps your chosen server
and window position — and does not silently delete the local database of anyone running
their own server.

### What happens when you run it

Double-click → a splash window appears within about 100 ms → the embedded server starts on
a free loopback port, or the remote one is contacted → the splash is replaced by the app.
No configuration, no separate server to launch, and the embedded mode works with no
internet connection.

The splash is not decoration. When the app points at a free-tier host, the server may be
asleep and take ~50 seconds to answer; after 8 seconds of silence the splash says so
explicitly, which is the difference between someone waiting and someone deciding the app
is broken.

Crucially, remote mode polls `/health` *before* navigating, and only accepts a JSON
`{"status":"ok"}` as proof the server is up. A sleeping host answers the first request
with its own branded holding page -- HTTP 200, valid HTML, paints instantly -- which would
otherwise satisfy `ready-to-show` and pull the splash away to reveal someone else's
loading screen. Waiting on the health check keeps the whole wake behind the splash. When
the server is already warm this costs one round trip, so a normal launch is unaffected.

Its data lives in `%APPDATA%\RocksCord\`:

| File | Contents |
|---|---|
| `data\rockscord.db` | Your database |
| `data\uploads\` | Uploaded files |
| `config.json` | Window size, signing key, mode |
| `server-url.txt` | The address the embedded server is on |
| `desktop.log` | Startup and error log, including the splash lifecycle |

Delete that folder to reset the app completely.

### Pointing the desktop app at a shared server

Best: bake it in at build time, so the copy you share needs no configuration.

```bash
npm run build:exe -- --server=https://your-app.onrender.com
```

Also available, without rebuilding:

- **File → Connect to a different server…** in the app — paste an address, test it, connect
- `RocksCord.exe --server=https://your-app.onrender.com` on the command line

The menu choice is remembered. The command-line flag applies to that launch only, and is
deliberately never written to `config.json` -- testing against another address should not
silently become the app's permanent server. See **[docs/SHARING.md](docs/SHARING.md)**.

### Faster builds while iterating

```bash
npm run build:exe -- --dir           # unpacked folder only, no installer
npm run build:exe -- --win portable  # just RocksCord.exe
```

---

## Deploying for free

Full walkthrough: **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**. The short version:

1. **Database** — create a free [Turso](https://turso.tech) database, copy its URL and token.
2. **Storage** *(only if you want file uploads to survive restarts)* — create a Supabase
   project and a **public** bucket called `rockscord-uploads`.
3. **Deploy** — push to GitHub, then on [Render](https://render.com) choose
   **New → Blueprint** and point it at the repo. [`render.yaml`](render.yaml) declares the
   whole service; Render prompts for the handful of secrets.
4. Set `PUBLIC_URL` to your Render URL once you know it, and redeploy.

Pushing to `main` redeploys automatically from then on.

A [`Dockerfile`](Dockerfile) is included for hosts that prefer an image (Fly.io, Koyeb,
Railway, a VPS).

---

## Security

| Concern | How it is handled |
|---|---|
| Passwords | Argon2id, 19 MiB / 2 passes / 1 lane (the OWASP minimum). Never logged or returned. |
| Account enumeration | An unknown account and a wrong password return the same status *and* the same message, and a dummy hash is verified so the timing matches. |
| Sessions | 15-minute JWT access tokens, kept in memory only; 30-day refresh tokens in `httpOnly` cookies, stored as SHA-256 hashes and rotated on every use. |
| Token theft | Replaying a rotated refresh token revokes every session for that account. |
| Authorisation | Every mutating route re-resolves permissions server-side. The client's checks only decide what to grey out. |
| Privilege escalation | You cannot grant a permission you do not hold, or edit a role at or above your own. |
| Channel privacy | A channel you cannot view returns 404, is absent from listings, cannot be subscribed to over the socket, and its messages are never fanned out to you. |
| XSS | Messages are parsed into tokens and rendered as React elements. `innerHTML` is never used, so injected markup is text by construction rather than by sanitising. |
| SQL injection | Every query is parameterised through Drizzle. FTS5 search terms are escaped into literal phrases. |
| Uploads | The real type is sniffed from the file's bytes; a declared `Content-Type` is never trusted. Filenames are stripped of paths, traversal, and Windows device names. Non-media downloads instead of rendering, with `nosniff` and a restrictive CSP. |
| Email verification | Registration issues no session until the address is confirmed. Links are 256-bit tokens stored only as SHA-256 hashes, single-use, expiring in 24 hours, and invalidated when a newer one is sent or when the account's address changes. |
| Rate limiting | Per-user when authenticated, per-IP otherwise. Tight limits on login, registration, password change, uploads, and sending. |
| Input | Every request body is validated with Zod. Invisible, control, and bidirectional-override characters are stripped from user text. |

### Email verification

Registration returns **no session**. The account exists, but until the address is
confirmed there is nothing to sign in with, and `/api/auth/login` answers `403
EMAIL_NOT_VERIFIED` — checked *after* the password, so it cannot be used to discover which
addresses are registered.

Configure a provider and it switches itself on. SMTP through an ordinary mailbox is the
recommended one, because it is the only free option with no domain requirement and no
approval queue:

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=your-16-character-app-password
```

Brevo and Resend are also supported via `EMAIL_API_KEY`; the driver is chosen from the key
prefix. Both have a catch worth reading about first — Brevo holds new accounts for manual
approval, and Resend without a verified domain delivers only to its own owner.

With no provider configured, the transport falls back to printing the link to the server
log and verification is **not** enforced. That is not a loophole, it is the only coherent
behaviour for an offline desktop install: demanding a click on a link that can never be
delivered would lock someone out of their own machine permanently. `REQUIRE_EMAIL_VERIFICATION`
overrides the inference in either direction.

[docs/EMAIL.md](docs/EMAIL.md) walks through the provider setup.

**Still not production-hardened**: no password reset, no 2FA, no CAPTCHA, and no moderation
tooling beyond kick/ban/audit log. Those are listed under
[Future improvements](#future-improvements).

---

## Known limitations

**Free-tier limits**

- Render free instances **sleep after 15 minutes** of inactivity; the next request takes
  ~50 seconds. 750 instance-hours per month across the workspace.
- Render free has **no persistent disk**, so uploads need Supabase Storage.
- Turso free: 5 GB, 500M row reads and 10M row writes per month.
- Supabase pauses a project after **7 days of inactivity**; you unpause it from the dashboard.
- Supabase free storage: 1 GB, 5 GB egress per month.

**Design limits**

- **Voice is a mesh**, so each participant uploads their audio once per other participant.
  Comfortable to about 6–8 people in one channel. More would need an SFU, which needs a
  paid server.
- **Single instance.** Presence and voice state live in memory, so running two server
  instances would split them. Horizontal scaling would need the Socket.IO Redis adapter and
  a shared presence store. Every free tier here runs exactly one instance.
- **Uploads are capability URLs.** Object keys carry 96 bits of randomness, so links are
  unguessable, but anyone *given* a link can open it without being in the channel. This is
  how image CDNs work; signing every URL would break plain `<img src>`.
- **No video calls** — screen sharing works, but there is no camera video.
- **Message history is not virtualised.** 400 messages are kept in memory per channel;
  older ones are re-fetched on scroll. Fine in practice, but not a virtualised list.
- **Light theme is not implemented.** The palette is entirely CSS custom properties in one
  file, so it is a token swap rather than a rewrite — but it is not done.
- **Verification mail can land in spam.** A brand-new sender has no reputation, so the
  first message to a given provider often gets filtered. The sign-in screen says so, and
  the resend button is one click — but it is a real cost of a free tier with no domain.
- **300 verification emails per day** on Brevo's free tier, shared with anything else you
  send from that account.
- **The executable is unsigned**, so Windows SmartScreen shows a warning on first run
  ("More info" → "Run anyway"). Code-signing certificates cost money.

---

## Future improvements

Roughly in the order I would do them:

1. **Password reset** — the email transport and single-use token machinery from
   verification are already in place, so this is largely a second route over the same parts.
2. **Message virtualisation** — render only the visible window so a 50,000-message channel
   scrolls as smoothly as a new one.
3. **Light theme** — the tokens are already isolated; this is mostly picking values.
4. **Read receipts and typing in the member list.**
5. **Threads** — the schema's `reply_to_id` already forms a tree; this is a UI problem.
6. **An SFU for large voice channels**, behind a feature flag, so the mesh stays the free
   default.
7. **Camera video**, reusing the existing screen-share negotiation path.
8. **Redis adapter and shared presence** so more than one instance can run.
9. **Mobile app** — React Native reusing `packages/shared` wholesale.
10. **End-to-end encryption for DMs** — the client already renders from tokens rather than
    HTML, so the rendering layer would not need to change.

---

<div align="center">

Built with TypeScript, Fastify, React, and SQLite.
No paid services, no proprietary assets.

</div>
