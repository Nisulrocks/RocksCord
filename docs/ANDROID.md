# Android

RocksCord ships an Android APK alongside the Windows installer. Both are built by the same
tag, so `v1.2.3` produces `RocksCord-Setup-1.2.3.exe` and `RocksCord-1.2.3.apk` on one
release.

---

## Installing it

Download `RocksCord-<version>.apk` from
[Releases](https://github.com/Nisulrocks/RocksCord/releases) and open it on the phone.

Android will refuse the first time and offer a settings toggle — "Install unknown apps" for
whichever app you downloaded with. That warning is about the app not coming from the Play
Store, not about anything it found in it.

The APK is signed with a checked-in debug key, so later versions install straight over
earlier ones without uninstalling first.

---

## How it works

The app is a WebView pointed at your deployment. It is the same arrangement as the desktop
app, and it has the same consequence: **UI and server changes reach phones on the next
launch from a plain `git push`.** The APK only needs rebuilding when something in the
native shell changes.

That is why the app is not a rewrite. The web client is already responsive — it collapses
to one pane at phone width, with the server rail and channel list behind a menu button —
so wrapping it gives a real app, and a React Native port would give the same screens for
months of work and a second copy of every feature to keep in step.

Loading the remote origin directly also keeps sign-in working with no special handling.
Sessions live in an httpOnly refresh cookie; bundling the client into the APK would put
the page on `https://localhost` while the API stayed on the deployment, making every
request cross-origin and the session cookie a third-party one that modern WebViews decline
to send.

**It needs a network connection.** There is no offline mode, and no local server the way
the desktop app has one.

---

## Building it

Cutting a release builds it for you:

```bash
npm version patch
git push --follow-tags
```

To build without tagging, run the Release workflow from the Actions tab — the APK is
attached to the run as an artifact even when there is no tag.

### Locally

You need the Android SDK and **JDK 21** — Gradle 8.11 rejects anything newer, with an
"Unsupported class file major version" that does not say so.

```bash
npm run build:apk
```

The APK lands in `apps/mobile/android/app/build/outputs/apk/debug/`. On Windows this needs
Git Bash, since the script calls `./gradlew`.

Point it somewhere else with:

```bash
ROCKSCORD_SERVER_URL=https://your-app.onrender.com npm run build:apk
```

CI takes the same value from the `SERVER_URL` repository variable, shared with the desktop
build so the two cannot drift apart.

---

## Permissions

Declared in `AndroidManifest.xml`, and requested only when something needs them:

| Permission | Asked for when |
|---|---|
| `INTERNET` | Always. It is the whole app |
| `RECORD_AUDIO` | Joining a voice channel |
| `CAMERA` | Turning the camera on in a call |
| `MODIFY_AUDIO_SETTINGS` | Alongside audio, for routing and echo cancellation |

A WebView cannot grant itself media access: Capacitor forwards the page's `getUserMedia`
request to Android, and Android can only grant what the manifest declares. Without these,
joining voice fails with an error that looks like a bug in the site.

Camera and microphone are declared `required="false"`, so the app stays installable on
hardware that has neither.

---

## Signing

Debug-signed, with the keystore committed at `apps/mobile/android/debug.keystore`.

Android identifies an app by its signature and refuses an update signed by a different
key. A debug keystore is generated per machine, so without a fixed one CI would mint a
fresh key every run and each new APK would fail to install over the last — reported as
"App not installed", which says nothing about the cause.

Committing *this* key is safe in a way that committing a release key would not be: the
alias and password are the Android defaults, published in Google's own documentation, and
understood to be non-secret. It cannot sign an update to anything signed with a real key.

**Play Store submission would need a real release key**, kept in repository secrets and
never committed. That also means the first store build cannot be an update to a sideloaded
one — different key, so it installs as a separate app.

---

## Known limitations

- No push notifications. Notifications arrive over the socket, so they only appear while
  the app is open — Android kills the WebView in the background.
- No offline mode. The desktop app can run its own embedded server; this cannot.
- Voice is a WebRTC mesh, same as everywhere else, so it is comfortable up to about 6–8
  people. On a phone it is also the fastest way to drain the battery.
- Unsigned by any store authority, so installing means accepting the "unknown apps"
  warning.
- The first launch after the server has slept waits on Render's cold start, ~50 seconds,
  with no splash of its own to explain the delay the way the desktop app has.
