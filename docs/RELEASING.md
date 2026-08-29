# Shipping an update

Most of the app already updates itself. The window loads the web client **from your
server**, so anything in `apps/web` or `apps/server` reaches everyone on their next launch
the moment Render finishes deploying — `git push` is the whole process.

This page is about the other part: the Electron shell (`apps/desktop`), which is compiled
into the executable and used to need a hand-delivered file.

---

## One-time setup

### 1. A public releases repository

Create an empty **public** repository called **`RocksCord-releases`** under your account.
Nothing goes in it but build artifacts.

It has to be public, and the reason matters. Whatever feed you configure is written into
every copy of the app as `app-update.yml`; pointing it at a private repository would mean
shipping a GitHub token inside the exe, which anyone could extract. A separate public
repository keeps your source private while letting the installer be downloaded
anonymously.

> Prefer to make the main repo public instead? Change `repo:` in
> [`apps/desktop/electron-builder.yml`](../apps/desktop/electron-builder.yml) to
> `RocksCord` and skip this step. For a portfolio project that is often what you want
> anyway.

### 2. A token

**[github.com/settings/tokens](https://github.com/settings/tokens)** → generate a token
with the **`repo`** scope. It is used only on your machine, at build time, to upload the
installer. It never goes into the app.

```powershell
$env:GH_TOKEN = "ghp_..."
```

---

## Releasing

### 1. Bump the version

In the **root** `package.json`:

```json
"version": "1.0.1"
```

**This is the step that actually ships anything.** The updater compares versions, so
publishing without a bump uploads a release that no installed copy will ever notice.

### 2. Build and publish

```bash
npm run build:exe -- --server=https://rockscord.onrender.com --release
```

That stages the app, packages the installer, and uploads it to the releases repository
along with `latest.yml`, which is the file installed copies read.

Without `--release` it builds locally and publishes nothing, which is what you want while
iterating.

### 3. Check the release exists

Open `https://github.com/YOUR-NAME/RocksCord-releases/releases`. You should see the new
version with `RocksCord-Setup-<version>.exe` and `latest.yml` attached.

If electron-builder created it as a **draft**, publish it — a draft is invisible to the
updater.

---

## What your friends experience

- The app checks 30 seconds after launch, then every 6 hours.
- An update downloads **in the background**, with no prompt. Asking permission to download
  is a question nobody can answer usefully, and it means the update is not ready at the
  moment they would have said yes.
- When it is ready they get one dialog: **Restart now** or **Later**. "Later" is the
  default button, so a stray Enter never restarts someone mid-sentence.
- Either way it installs when they next quit.
- **Help → Check for updates…** forces a check, and always answers — silence in response to
  a deliberate check reads as broken.

Failures are logged and never shown. An update that cannot download is not something the
user did or can fix, the app keeps working on the version it has, and the next check may
succeed.

---

## Two things that will catch you out

**The first update is the one nobody gets automatically.** Copies installed from a build
made *before* the updater existed have no updater in them. Everyone needs **one** more
manual install of a release built from this commit or later; after that it is automatic
forever.

**The portable exe never self-updates.** It runs from a temporary extraction that is
discarded on exit, so there is nowhere to write an update. The app detects this and stays
quiet rather than reporting failures it cannot act on — and **Help → Check for updates…**
says so plainly. Anyone who wants automatic updates needs the installer.

---

## Which changes need a release

| Changed | Reaches people via |
|---|---|
| `apps/server` | `git push` → Render |
| `apps/web` | `git push` → Render |
| `packages/shared` | `git push` → Render |
| **`apps/desktop`** | **a release** |
| `apps/desktop/electron-builder.yml` | **a release** |
| Icons (`npm run icons`) | a release, for the window/installer icon |

If you only touched the first three, do not cut a release — there is nothing in it.

---

## Troubleshooting

**`--release` says a token is required**
`GH_TOKEN` is not set in the shell you are running from. Setting it in another terminal
does not carry over.

**Uploads fail with 404**
The releases repository does not exist yet, or `owner`/`repo` in `electron-builder.yml`
does not match it.

**The log shows `auto-update: check failed: 404`**
Same cause, seen from the app side: it is looking at a feed that is not there. Harmless —
the app keeps working — but no update will ever arrive until the repository exists and has
a published release.

**Nothing happens even though a release exists**
Check the version is actually higher than the installed one, and that the release is
published rather than a draft. `%APPDATA%\RocksCord\desktop.log` records every check.

**SmartScreen warns on the update**
Expected: the build is unsigned, which is also why
`win.verifyUpdateCodeSignature: false` is set — electron-updater otherwise refuses to
apply an update whose publisher it cannot verify, which for an uncertified build is every
one.
