<div align="center">

<img src="assets/icon-source.png" width="110" alt="RocksCord" />

# RocksCord

Real-time chat, voice, and communities.
Runs locally, ships as a Windows app, deploys free.

</div>

---

## Features

**Chat** — text channels, DMs, replies, edits, reactions, mentions, pins, an emoji picker,
markdown formatting, and full-text search.

**Voice and video** — peer-to-peer WebRTC audio, camera, screen sharing, mute, deafen,
speaking detection, per-peer volume, and device selection with a live mic meter.

**Servers** — invites, roles, a 22-permission bitfield with per-channel overwrites, kicks,
bans, and an audit log.

**Accounts** — Argon2id passwords, rotating refresh tokens, avatars, custom status,
presence with automatic idle, friends, and optional email verification.

**Apps** — a web client and a Windows desktop app that embeds the server, with a splash
screen and automatic updates.

---

## Quick start

Needs Node 20.11+.

```bash
npm install
npm run setup
npm run dev
```

Open <http://localhost:5173>. The setup step creates the database, seeds demo data, and
writes a `.env` — no configuration needed.

Demo accounts, password `password123`:

| Email | Role |
|---|---|
| `alex@rockscord.test` | Owner |
| `nova@rockscord.test` | Admin |
| `kit@rockscord.test` | Member |

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server and web client with hot reload |
| `npm run build` | Build everything |
| `npm start` | Run the production server (serves the built client) |
| `npm test` | Server test suite |
| `npm run typecheck` | Typecheck all workspaces |
| `npm run build:exe` | Build the Windows installer and portable exe |
| `npm run db:seed` | Seed demo data |
| `npm run db:reset` | Drop and recreate the database |
| `npm run icons` | Regenerate icons and installer art from one source PNG |
| `npm run smoke` | End-to-end check against a running server |
| `npm run test:email` | Send a test email through the configured provider |

---

## Project structure

```
apps/
  server/        Fastify API, Socket.IO gateway, Drizzle schema and migrations
  web/           React client
  desktop/       Electron shell
packages/
  shared/        Types, zod schemas, permission bitfield — used by both sides
scripts/         setup, build, icon, and diagnostic scripts
docs/            architecture, deployment, testing, releasing
```

`packages/shared` holds the permission resolver and validation schemas, so the client and
server enforce the same rules from the same code.

---

## Configuration

Everything has a working default; `npm run setup` writes a `.env` for you.
[`.env.example`](.env.example) documents every option.

| Variable | Default | |
|---|---|---|
| `PORT` | `4000` | API port |
| `DATABASE_URL` | `./data/rockscord.db` | Local SQLite, or a `libsql://` Turso URL |
| `JWT_SECRET` | generated | Required in production |
| `PUBLIC_URL` | detected | Base URL for attachment links |
| `STORAGE_DRIVER` | `local` | `local` or `supabase` |
| `CORS_ORIGIN` | `*` | Comma-separated origins |
| `EMAIL_API_KEY` | — | Brevo key; enables verification emails |
| `REQUIRE_EMAIL_VERIFICATION` | `false` | Whether unverified accounts can sign in |

---

## Desktop app

```bash
npm run build:exe -- --server=https://your-app.onrender.com
```

Produces an installer and a portable exe in `apps/desktop/release/`. The URL is compiled
in, so it connects with no setup.

Without `--server` the app runs its own embedded server and works offline.

The installed app updates itself: it checks on launch and every six hours, downloads in
the background, and installs on next quit. Only the Electron shell needs this — the window
loads the web client from your server, so `apps/web` and `apps/server` changes arrive on
the next launch from a plain `git push`. See [docs/RELEASING.md](docs/RELEASING.md).

---

## Deploying

Free, no credit card: **Render** for the server, **Turso** for the database, optionally
**Supabase Storage** for uploads.

Push to GitHub, then on Render: **New → Blueprint**, point it at the repo, and fill in the
two Turso values. [`render.yaml`](render.yaml) describes the rest.

After that, `git push` deploys. Full walkthrough in
[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

---

## Testing

```bash
npm test          # 175 tests
npm run smoke     # end-to-end against a running server
```

Tests run against a real database and the real HTTP stack — routes, permissions, auth,
uploads, and the Socket.IO gateway. [docs/TESTING.md](docs/TESTING.md) also has a manual
checklist and instructions for testing with several users at once.

---

## Security

| | |
|---|---|
| Passwords | Argon2id, 19 MiB / 2 passes |
| Sessions | 15-minute access tokens in memory, 30-day refresh tokens in `httpOnly` cookies, rotated on use |
| Token theft | Replaying a rotated refresh token revokes every session for the account |
| Authorisation | Re-resolved server-side on every mutating route |
| Channel privacy | Hidden channels 404, are absent from listings, and are never fanned out over the socket |
| XSS | Messages render as React elements from parsed tokens; `innerHTML` is never used |
| SQL injection | Parameterised throughout; FTS5 terms escaped to literal phrases |
| Uploads | Type sniffed from bytes, filenames sanitised, non-media forced to download |
| Rate limiting | Per-user when authenticated, per-IP otherwise |
| Input | Zod on every request body; control and bidi characters stripped |

Not production-hardened: no password reset, 2FA, or CAPTCHA.

---

## Known limitations

- Render's free tier sleeps after 15 minutes; the first request takes ~50 seconds.
- Free instances have no persistent disk, so uploads need Supabase Storage to survive
  restarts.
- Voice is a mesh, so it is comfortable up to about 6–8 people per channel.
- Presence and voice state are in-memory, so the server runs as a single instance.
- Attachment URLs are unguessable but not access-checked — anyone with the link can open
  it, the same model image CDNs use.
- Message history is not virtualised.
- The portable exe cannot self-update.
- The executable is unsigned, so SmartScreen warns on first run.
- Email verification is off by default; see [docs/EMAIL.md](docs/EMAIL.md).

---

## Docs

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How it works, and why it is built this way |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Free hosting, start to finish |
| [SHARING.md](docs/SHARING.md) | Getting the app to your friends |
| [TESTING.md](docs/TESTING.md) | Automated tests and a manual checklist |
| [RELEASING.md](docs/RELEASING.md) | Cutting a desktop release |
| [EMAIL.md](docs/EMAIL.md) | Email verification setup |

---

<div align="center">

Built with TypeScript, Fastify, React, and SQLite.

</div>
