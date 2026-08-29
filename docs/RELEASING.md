# Shipping an update

Most of the app already updates itself. The window loads the web client **from your
server**, so anything in `apps/web` or `apps/server` reaches everyone on their next launch
the moment Render finishes deploying — `git push` is the whole process.

This page is about the other part: the Electron shell (`apps/desktop`), which is compiled
into the executable and used to need a hand-delivered file.

---

## Releasing

From a clean `main`:

```bash
npm version patch
git push --follow-tags
```

`npm version` bumps `package.json`, commits, and creates a `v1.1.2` tag. Pushing the tag
starts the **Release** workflow, which typechecks, runs the tests, builds the installer on
a Windows runner, and publishes it to GitHub Releases.

Use `minor` for new features and `major` for breaking changes; the number itself only has
to increase, since that is what the updater compares.

Watch it at **Actions → Release**. It takes roughly five minutes.

### Why a tag rather than every push

Most commits change the server or the web client, and those reach people through Render
with no installer involved. Releasing on every push would have everyone's app download
99 MB to gain nothing.

### There is no token to manage

The workflow uses the token Actions provides. Nothing expires, and nothing is stored on
your machine — if you made a personal access token earlier, you can revoke it.

The `contents: write` permission in the workflow is what lets that token create a release.
Without it the upload fails with the same 403 a personal token missing that permission
produces.

### The tag has to match package.json

The workflow checks this and fails loudly if they differ. It guards the one mistake the
updater cannot recover from: tagging `v1.2.0` while the manifest still says `1.1.1`
produces a release nobody is ever offered, because the updater compares the version
compiled into the build, not the tag. Using `npm version` moves both together.

---

## Releasing by hand

Still works, and is useful when the workflow itself is what is broken:

```powershell
$env:GH_TOKEN = "ghp_..."
npm run build:exe -- --server=https://rockscord.onrender.com --release
```

That needs a token with **Contents: Read and write** on the repository — fine-grained at
[github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens),
or a classic one with `repo`.

Without `--release` it builds locally and publishes nothing, which is what you want while
iterating.

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

**The workflow did not run**
It triggers on tags, not commits. `git push` alone does nothing; you need
`git push --follow-tags`, or push the tag explicitly.

**The workflow failed on "Check the tag matches package.json"**
The tag and the manifest disagree. Delete the tag, bump properly with `npm version`, and
push again:

```bash
git tag -d v1.2.0
git push origin :refs/tags/v1.2.0
```

**The workflow failed on tests or typecheck**
Deliberate. A broken build published to the update feed would install itself on everyone's
machine automatically, which is a considerably worse outcome than a failed release.

**`--release` says a token is required**
`GH_TOKEN` is not set in the shell you are running from. Setting it in another terminal
does not carry over.

**Uploads fail with 404**
`owner`/`repo` in `electron-builder.yml` does not match your repository.

**The log shows `auto-update: check failed: 404`**
Same cause from the app side: it is looking at a feed that is not there. Harmless — the
app keeps working — but nothing arrives until the repo is public and has a published
release.

**Nothing happens even though a release exists**
Check the version is actually higher than the installed one, and that the release is
published rather than a draft. `%APPDATA%\RocksCord\desktop.log` records every check.

**SmartScreen warns on the update**
Expected: the build is unsigned, which is also why
`win.verifyUpdateCodeSignature: false` is set — electron-updater otherwise refuses to
apply an update whose publisher it cannot verify, which for an uncertified build is every
one.
