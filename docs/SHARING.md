# Sharing RocksCord with friends

**The one thing to understand:** by default the executable runs its own private server on
your machine. If you hand that exe to a friend, they get *their own* private server and
*their own* database — you would not see each other's accounts or messages at all.

To chat together, everyone must connect to **one shared server**. This guide sets that up
so your friends do nothing but double-click.

Two routes:

| Route | Who can join | Setup time | Best for |
|---|---|---|---|
| **[A. Free server on Render](#route-a--free-server-on-the-internet)** | Anyone, anywhere | ~20 min | The real thing |
| **[B. Your own PC over Wi-Fi](#route-b--your-own-pc-on-the-same-wi-fi)** | Same network only | ~5 min | A quick test today |

---

## Route A — free server on the internet

Free forever, no credit card. Two accounts (Turso for the database, Render for hosting),
then one command to build the exe.

### A1. Put the code on GitHub

Render deploys from a repository, so it needs one.

```bash
cd C:\Users\Nisul_rocks\Desktop\DiscordClone
git init
git add .
git commit -m "RocksCord"
```

Create an empty repository at [github.com/new](https://github.com/new) — **do not** add a
README or .gitignore, since you already have both — then:

```bash
git remote add origin https://github.com/YOUR-USERNAME/rockscord.git
git branch -M main
git push -u origin main
```

> The `.gitignore` already excludes `.env`, `data/`, `node_modules/`, and the 98 MB build
> output, so nothing secret or bulky gets pushed.

### A2. Create the database (Turso)

The free tier is 5 GB with no card and no expiry.

1. Sign up at **[turso.tech](https://turso.tech)** with GitHub.
2. Create a database — the dashboard button is fine, no CLI needed. Call it `rockscord`.
3. Open it and copy two things:
   - the **Database URL**, which looks like `libsql://rockscord-yourname.turso.io`
   - a **token** — click *Create Token*, then copy it (it is long; it is only shown once)

Keep both somewhere for the next step. You do not need to create any tables — the app
does that itself on first boot.

### A3. Deploy (Render)

Free tier, no card, and WebSockets work on it.

1. Sign up at **[render.com](https://render.com)** with GitHub.
2. **New → Blueprint**, pick your repository. Render reads
   [`render.yaml`](../render.yaml), which already describes the whole service.
3. It will prompt for a few values:

   | Prompt | What to paste |
   |---|---|
   | `DATABASE_URL` | your Turso URL |
   | `DATABASE_AUTH_TOKEN` | your Turso token |
   | `SUPABASE_URL` | leave blank *(see the note below)* |
   | `SUPABASE_SERVICE_KEY` | leave blank |

   Leaving the Supabase fields blank is fine — the blueprint ships with
   `STORAGE_DRIVER=local`, so the service boots without them.

4. Click **Apply**. The first build takes about 4 minutes.

5. When it goes live, copy the URL at the top — something like
   `https://rockscord.onrender.com`. That is the address your friends' app connects to.

   There is nothing else to configure: the server reads its own public address from
   Render, so links to avatars and uploaded images work straight away.

**Check it worked** — open `https://your-app.onrender.com/health` in a browser. You want:

```json
{"status":"ok","database":"up","uptimeSeconds":12,"version":"1.0.0"}
```

> **About file uploads.** Render's free tier has no permanent disk, so uploaded images
> disappear whenever the service restarts. Everything else works. If you want uploads to
> stick around, add free Supabase Storage — [DEPLOYMENT.md](DEPLOYMENT.md#step-2--file-storage-supabase)
> covers it in five minutes. You can add it later.

### A3b. Turn on email verification (optional, 10 minutes)

Without this, anyone can register with a made-up address like `a@b.c` and be signed in
immediately. With it, an account cannot sign in until its owner clicks a link.

1. Sign up at **[brevo.com](https://www.brevo.com)** — free, 300 emails a day, no card.
2. **Senders → Add a sender**, use your own Gmail address, and click the link Brevo sends
   you.
3. **SMTP & API → API Keys → Generate a new API key**, and copy it.
4. On Render: your service → **Environment** → add two variables, then save.

   | Key | Value |
   |---|---|
   | `EMAIL_API_KEY` | the key from step 3 |
   | `EMAIL_FROM` | the address you verified in step 2 |

Render restarts the service by itself. Check it took:

```
https://your-app.onrender.com/api/auth/config
```

`"requireEmailVerification":true` means it is live.

> Tell your friends to check their spam folder. A brand-new sender with no domain has no
> reputation, so the first message often gets filtered. The app's own screen says this too,
> and the resend button is one click.

See [EMAIL.md](EMAIL.md) for the details.

### A4. Build the exe that points at it

One command, on your machine:

```bash
npm run build:exe -- --server=https://your-app.onrender.com
```

That address is compiled into the executable. Anyone who runs it connects to your server
on first launch — **no picker, no typing, no instructions**.

Two files come out, in `apps\desktop\release\`:

```
RocksCord-Setup-1.0.0.exe    the installer -- send this one
RocksCord.exe                portable, for anyone who would rather not install
```

### A5. Send it

Upload `RocksCord-Setup-1.0.0.exe` to Google Drive, Dropbox, or WeTransfer and send the
link. It is ~99 MB, so Discord's own 25 MB attachment limit will not take it.

The installer is entirely self-contained -- the Electron runtime, the Node server, the
database engine, the web client, and your server's address are all inside that one file.
Nothing else has to be installed first.

Tell your friends two things:

1. Windows SmartScreen will warn about an unknown publisher — click **More info** →
   **Run anyway**. That is because the exe is not code-signed (certificates cost money);
   it is not a sign of anything wrong.
2. A splash window appears almost immediately. If your Render service was asleep it
   will say so while it wakes -- up to about a minute for whoever opens the app first.
   After that it is instant.

They open it, register an account, and they are in your server with you.

If you set up email verification, add a third thing: they will need to click the link in
the confirmation email before they can sign in, and it may land in spam.

---

## Route B — your own PC on the same Wi-Fi

No accounts, no deploying. Only works for people on the same network, and only while your
PC is on and the server is running. Good for testing this afternoon.

### B1. Find your PC's address

```bash
ipconfig
```

Look for **IPv4 Address** under your active adapter — something like `192.168.0.6`.

### B2. Start the server

```bash
npm run build
npm start
```

It binds to all network interfaces, so other devices can reach it. Leave that window open.

### B3. Allow it through the firewall

The first time, Windows asks whether to allow Node.js on the network. Tick **Private
networks** and allow it.

If you clicked no earlier, run this once in an **Administrator** PowerShell:

```powershell
New-NetFirewallRule -DisplayName "RocksCord" -Direction Inbound -LocalPort 4000 -Protocol TCP -Action Allow -Profile Private
```

Check it from your phone on the same Wi-Fi: open `http://192.168.0.6:4000/health`.

### B4. Build the exe

```bash
npm run build:exe -- --server=http://192.168.0.6:4000
```

Send that exe to friends on the same network. Or skip the exe entirely — they can just
open `http://192.168.0.6:4000` in a browser.

> Your LAN IP can change when you reconnect to Wi-Fi. If the app stops connecting, check
> `ipconfig` again and rebuild, or reserve a static IP in your router.

---

## If you change servers later

You do not have to rebuild. In the app:

**File → Connect to a different server…**

Paste an address, click **Test** to check it is reachable, then **Connect**. The app
restarts into the new server. The same screen has **Just use this computer** to go back to
a private local server.

---

## What lives where

| | Route A (Render) | Route B (your PC) | Default (no server set) |
|---|---|---|---|
| Accounts and messages | Turso, in the cloud | `data\rockscord.db` on your PC | `%APPDATA%\RocksCord\data` on each machine |
| Who can join | Anyone with the exe | Same Wi-Fi only | Nobody — one machine only |
| Needs your PC on | No | Yes | — |
| Uploaded files | Supabase, or lost on restart | `data\uploads` on your PC | Local |

---

## Troubleshooting

**"Could not reach that address"**
Open `<address>/health` in a browser. No response means the server is not running or the
address is wrong. On Render, check the service is not suspended.

**First connection takes ~50 seconds**
Render's free tier sleeps after 15 minutes with no traffic. The first person in wakes it.
Ask someone to open the URL a minute before everyone joins, or upgrade to remove it.

**A friend never got their confirmation email**
Check spam first — that is nearly always it. The app's "check your inbox" screen has a
**Resend** button. If nothing arrives at all, open the Render logs and look for a line about
Brevo rejecting the message; it usually means `EMAIL_FROM` is not the sender address you
verified.

**A friend sees an empty app with no servers**
That is correct — accounts are shared, but they still need to be invited to a *server*
inside the app. Open your server → **Invite people** → copy the link → send it. Or have
them paste the invite code into **Join with an invite**.

**Uploaded images show as broken**
`PUBLIC_URL` on Render does not match the real URL, or the service restarted with
`STORAGE_DRIVER=local`. Set `PUBLIC_URL` correctly, and add Supabase Storage for
persistence.

**Voice does not connect between two friends**
Most home networks are fine on STUN alone. On restrictive networks (some university or
corporate Wi-Fi) you need a TURN relay. Free option: sign up at
[metered.ca](https://www.metered.ca/tools/openrelay/) for 20 GB/month, then set `TURN_URL`,
`TURN_USERNAME`, and `TURN_CREDENTIAL` on Render.

**Where are the logs?**
Server: the Render dashboard → **Logs**.
Desktop app: `%APPDATA%\RocksCord\desktop.log`.
