# Email verification

**Currently off.** Registration signs people straight in. Everything below describes how to
switch it on when you have a mail provider that actually delivers.

The machinery is built, tested, and shipped — it is the enforcement that is disabled, by a
single environment variable.

---

## Why it is off

Free transactional email turns out to have a gate in front of every option, and none of
them are visible until you try to send:

| Provider | The gate |
|---|---|
| **Brevo** | Holds new accounts for manual approval. Answers `403 permission_denied` to every send until a human agrees |
| Resend | Without a verified **domain**, delivers only to the address the Resend account was registered with |
| SMTP2GO | Sender verification in practice expects a business domain |
| Gmail / any SMTP | Render's free instances [block outbound ports 25, 465 and 587](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports) |

Brevo is kept because it is the closest to workable: free, no domain, 300/day, and the only
thing standing in the way is an approval that may yet arrive.

The lesson is baked into the code. Enforcement used to be inferred from whether a provider
looked configured, which conflates **"the key was accepted"** with **"the message was
delivered"**. Those are different claims, and when the second turned out false the result
was accounts that could never sign in *and* never receive the link that would fix them.
Enforcement is now an explicit decision you make after seeing mail arrive.

---

## What still happens with it off

- Registration creates the account and signs the user straight in.
- `emailVerifiedAt` is stamped immediately, so nobody is left in limbo if you switch
  enforcement on later.
- No email is sent and no provider is contacted.

Existing unverified accounts — including any stranded during earlier attempts — can sign in
normally.

---

## Turning it on

### 1. Get Brevo sending

1. Sign up at **[brevo.com](https://www.brevo.com)**.
2. **[Senders](https://app.brevo.com/senders/list)** → **Add a sender**. Use an address you
   can open. Brevo emails it a confirmation link — click it, or every send is refused.
3. **[API keys](https://app.brevo.com/settings/keys/api)** → **Generate a new API key**
   (`xkeysib-…`). Copy it; it is shown once.

If sends come back **403 not activated**, the account is still awaiting approval. Look for
an activation prompt on the Transactional page, or email **contact@brevo.com** describing
what you send: transactional account-verification email for a small chat app, low volume.

### 2. Set the credentials

On **Render**: your service → **Environment**. Render restarts the service by itself.

```
EMAIL_API_KEY=xkeysib-...
EMAIL_FROM=the-address-you-confirmed@gmail.com
```

At this point links are generated and sent, but nobody is barred from signing in. That is
deliberate: it lets you confirm delivery works before it can lock anyone out.

### 3. Prove that mail arrives

```bash
npm run test:email -- you@example.com
```

It sends through Brevo with the same payload the server uses and prints the reply verbatim,
mapping each common rejection to its one fix. **Do not skip this.**

### 4. Only then, enforce it

Add one more variable:

```
REQUIRE_EMAIL_VERIFICATION=true
```

Registration now withholds the session until the link is clicked, and `/api/auth/login`
answers `403 EMAIL_NOT_VERIFIED` — after checking the password, so it cannot be used to
discover which addresses are registered.

To turn it back off, set it to `false` or delete it. Accounts created while it was on and
never confirmed will then be able to sign in.

---

## How it behaves when on

Registration returns **no session** and a `verificationRequired` response. The app shows a
"check your inbox" screen with a resend button. Trying to sign in first gives:

```json
{"error":{"code":"EMAIL_NOT_VERIFIED","message":"Confirm your email address before signing in"}}
```

Links are single-use, expire after 24 hours, are stored only as SHA-256 hashes, and are
retired when a newer one is issued or the account's address changes. Resending is limited
to 15 attempts per 15 minutes with a 60-second cooldown between actual sends.

The register response carries `emailSent`. When the provider refuses, the screen says so
rather than sending someone to hunt through a spam folder for a message that was never
accepted.

---

## Testing the flow with no provider

```bash
REQUIRE_EMAIL_VERIFICATION=true npm start
```

The console transport prints the link to the terminal:

```
------------------------------------------------------------------------
  EMAIL (not sent -- no provider configured)
  To:      friend@example.com
  Subject: Confirm your RocksCord email address
  Link:    http://localhost:4000/api/auth/verify-email?token=eOu08KcN...
------------------------------------------------------------------------
```

Register, copy the link, paste it into a browser, then sign in. This exercises the whole
path without an account anywhere.

---

## Settings

| Variable | Default | What it does |
|---|---|---|
| `REQUIRE_EMAIL_VERIFICATION` | `false` | The switch. Nothing is enforced unless this is `true` |
| `EMAIL_DRIVER` | `auto` | `auto`, `brevo`, or `console` |
| `EMAIL_API_KEY` | — | Brevo key (`xkeysib-…`). Selects Brevo when set |
| `EMAIL_FROM` | — | Sender address confirmed with Brevo. Required alongside the key |
| `EMAIL_FROM_NAME` | `RocksCord` | Display name on the message |
| `EMAIL_VERIFICATION_TTL_SECONDS` | `86400` | How long a link stays valid |

---

## Existing accounts

The migration marks every account created before this feature as verified, using its
original creation date. They were made when no confirmation was asked for, so there is no
address to re-confirm — and leaving them unverified would lock out everyone on a running
deployment, including you, the moment enforcement was switched on.

Seeded demo accounts are created pre-verified, since their addresses are fictional.

---

## Troubleshooting

**Nothing seems to be linked**
`/api/auth/config` reports two independent flags, and the pair tells you which of two
opposite problems you have:

| `emailConfigured` | `requireEmailVerification` | What it means |
|---|---|---|
| `false` | `false` | No provider. `EMAIL_API_KEY` is not reaching the process |
| `true` | `false` | Provider is live, but the switch is off — set `REQUIRE_EMAIL_VERIFICATION=true` |
| `true` | `true` | Fully on |
| `false` | `true` | Forced on with no provider; links go to the server log only |

**`requireEmailVerification` is `false`**
That is the default. Set `REQUIRE_EMAIL_VERIFICATION=true` and confirm the restart
finished.

**The service will not start: "EMAIL_FROM is required"**
A key is set but no sender address. Set both, or neither.

**403 `permission_denied` from Brevo**
The account has not been approved for sending. Nothing about your key, sender, or this app
is wrong. Leave enforcement off until `npm run test:email` succeeds.

**Nothing arrives, and nothing appears in the logs**
The register response carries `emailSent`. A send failure never fails the registration
itself — the account is real, and resending will retry — but the provider's own explanation
goes to the server log, and `npm run test:email` reproduces it.

**It lands in spam**
Expected for a new sender with no domain reputation, especially the first message to a
given provider. Marking it "not spam" once usually fixes it for that recipient.
