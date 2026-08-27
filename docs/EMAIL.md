# Email verification

RocksCord confirms email addresses before letting an account sign in. This page covers
choosing a provider, setting it up, and what to do when mail does not arrive.

---

## What it does

Registering creates the account and sends a link, but returns **no session** — there is
nothing to sign in with until the address is confirmed. Trying to sign in first gives:

```json
{"error":{"code":"EMAIL_NOT_VERIFIED","message":"Confirm your email address before signing in"}}
```

The app turns that into a "check your inbox" screen with a resend button, whether it was
reached by registering or by signing in to an old unconfirmed account.

Links are single-use, expire after 24 hours, and are replaced whenever a new one is sent.

---

## Without a provider

**The app works with no email account at all.** Local development, the test suite, and the
packaged desktop build all run unchanged.

With nothing configured, the transport prints the link to the server log:

```
------------------------------------------------------------------------
  EMAIL (not sent -- no provider configured)
  To:      friend@example.com
  Subject: Confirm your RocksCord email address
  Link:    http://localhost:4000/api/auth/verify-email?token=eOu08KcN...
------------------------------------------------------------------------
```

and verification is **not enforced** — registration signs you straight in.

That inference is deliberate. The desktop build runs its own server on the user's machine
with no way to send anything, so requiring a click on a link that could never arrive would
lock people out of their own computer. `REQUIRE_EMAIL_VERIFICATION=true` demands it anyway,
which is how to exercise the flow locally: you copy the link out of the terminal.

---

## Choosing a provider

One requirement eliminates most of the market: **sending to addresses you do not own,
without owning a domain.** Your users' addresses are not yours, and a domain costs money.

| Provider | Free allowance | Emails anyone? | Needs a domain? | Gatekeeping |
|---|---|---|---|---|
| **SMTP (Gmail)** | 500/day | Yes | No | None — works immediately |
| **Brevo** | 300/day | Yes | No | New accounts held for manual approval |
| **Resend** | 3,000/month | **No**, not without a domain | **Yes** | Instant, once a domain is verified |

**Start with SMTP.** It is the only one of the three with nothing standing between you and
a delivered message, and Gmail's allowance is the largest. Move to Resend later if you buy
a domain — it is the nicest of the three once that is true.

### Why Resend cannot be the free default

Until a domain is verified, a Resend account may only send from `onboarding@resend.dev`,
and messages from that address are delivered **only to the address the Resend account was
registered with**. It is a sandbox, not a starter tier.

That failure is unusually nasty: your own test email arrives, so everything looks correct,
and every message to an actual user vanishes. RocksCord's Resend driver detects that
specific rejection and says so explicitly rather than letting it look like a bug here.

If you own a domain, Resend is an excellent choice — verify it under **Domains**, set
`EMAIL_FROM` to an address at that domain, and the restriction disappears.

### Why Brevo may not work either

Brevo holds new accounts before permitting any transactional send, and refuses everything
until a human approves:

```
HTTP 403 — "Unable to send email. Your SMTP account is not yet activated.
            Please contact us at contact@brevo.com to request activation"
```

Approval takes a day or so, and is sometimes declined without much explanation. If you are
stuck there, switch to SMTP rather than waiting.

---

## Setup: SMTP with Gmail (recommended)

No domain, no approval queue, no third-party signup. About five minutes.

### 1. Turn on 2-Step Verification

App passwords do not exist without it: **[myaccount.google.com/security](https://myaccount.google.com/security)**
→ **2-Step Verification**.

### 2. Create an app password

**[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)** → name it
`RocksCord` → **Create**.

You get 16 characters in four groups. Copy it — it is shown once. This is *not* your Google
password, and it can be revoked on its own without touching your account.

### 3. Set four variables

On **Render**: your service → **Environment** → add these, then save. The service restarts
itself; there is no redeploy to trigger.

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=the 16-character app password
```

`EMAIL_FROM` defaults to `SMTP_USER`, so it can be left unset. Locally, put the same lines
in `.env`.

Verification switches itself on as soon as SMTP is configured.

> An existing `EMAIL_API_KEY` can stay or go — SMTP takes precedence when both are set.

### 4. Check it

```bash
npm run test:email -- you@gmail.com
```

Then:

```bash
curl.exe https://your-app.onrender.com/api/auth/config
```

`"requireEmailVerification":true` means the server picked it up.

---

## Setup: Brevo

1. Sign up at **[brevo.com](https://www.brevo.com)**.
2. **[Senders](https://app.brevo.com/senders/list)** → **Add a sender**. Use an address you
   can open. Brevo emails it a confirmation link — click it, or every send is refused.
3. **[API keys](https://app.brevo.com/settings/keys/api)** → **Generate a new API key**.
   Copy it; it is shown once.
4. Set `EMAIL_API_KEY` and `EMAIL_FROM` on your host.

If sends come back **403 not activated**, see [above](#why-brevo-may-not-work-either).

---

## Setup: Resend

**Only worth doing if you own a domain.** See [above](#why-resend-cannot-be-the-free-default).

1. Sign up at **[resend.com](https://resend.com)**.
2. **Domains** → **Add Domain**, then add the DNS records it gives you at your registrar.
3. **API Keys** → **Create API Key**. Resend keys start `re_`.
4. Set `EMAIL_API_KEY` and an `EMAIL_FROM` at your verified domain, e.g.
   `no-reply@yourdomain.com`.

The driver is picked from the key prefix, so no `EMAIL_DRIVER` is needed.

---

## Settings

| Variable | Default | What it does |
|---|---|---|
| `EMAIL_DRIVER` | `auto` | `auto`, `smtp`, `brevo`, `resend`, `console` |
| `SMTP_HOST` | — | e.g. `smtp.gmail.com`. Setting it selects SMTP |
| `SMTP_PORT` | `587` | 587 for STARTTLS, 465 for implicit TLS. Never 25 |
| `SMTP_USER` | — | The mailbox address |
| `SMTP_PASSWORD` | — | App password, not the account password |
| `EMAIL_API_KEY` | — | Brevo (`xkeysib-…`) or Resend (`re_…`) key |
| `EMAIL_FROM` | `SMTP_USER` | Sender address the provider will accept |
| `EMAIL_FROM_NAME` | `RocksCord` | Display name on the message |
| `REQUIRE_EMAIL_VERIFICATION` | inferred | Overrides the inference in either direction |
| `EMAIL_VERIFICATION_TTL_SECONDS` | `86400` | How long a link stays valid |

`auto` reads the credentials: SMTP if a host is configured, then Resend if the key starts
`re_`, then Brevo if any key is set, otherwise the console.

---

## Existing accounts

The migration marks every account created before this feature as verified, using its
original creation date. They were made when no confirmation was asked for, so there is no
address to re-confirm — and leaving them unverified would lock out everyone on a running
deployment, including you, the moment it ran.

Seeded demo accounts are created pre-verified, since their addresses are fictional.

---

## When mail does not arrive

Run the diagnostic first. It sends through whichever provider is configured, with the same
payload the server uses, and prints the reply verbatim:

```bash
npm run test:email -- you@example.com
```

If nothing is configured locally it asks which provider to test and prompts for the
details. Nothing is stored.

It maps each provider's common rejections to their one fix — a bad app password, an
unconfirmed Brevo sender, Resend's sandbox, an account awaiting approval — so a failure
names what to change rather than leaving you to search for it.

If it reports **Accepted** and nothing arrives, the configuration is fine and the problem
is delivery: check the provider's own sending log for a bounce or a block.

---

## Troubleshooting

**`requireEmailVerification` is `false`**
No provider was detected. Confirm the variables are on the service itself (not a linked
environment group) and that the restart finished.

**The service will not start: "EMAIL_FROM is required"**
A provider is configured but no sender address, and none could be inferred. Set
`EMAIL_FROM`, or set `SMTP_USER` to an address.

**"Invalid login: 535 … BadCredentials" from Gmail**
An ordinary account password was used. Generate an app password (step 2 above); it needs
2-Step Verification switched on first.

**Nothing arrives, and nothing appears in the logs**
The register response carries `emailSent`. `false` means the provider refused, and the app
says so on screen rather than sending you to your spam folder. A send failure never fails
the registration itself — the account is real, and resending will retry.

**"Too many attempts. Try again in …"**
Resending is limited to 15 attempts per 15 minutes, on top of a 60-second cooldown between
actual sends. The message says how long to wait.

**It lands in spam**
Expected for a new sender with no domain reputation, especially the first message to a
given provider. Marking it "not spam" once usually fixes it for that recipient. Sending
through Gmail's SMTP rather than a cold provider account helps considerably, because the
mail leaves an established relay.

**Testing the whole flow with no provider**

```bash
REQUIRE_EMAIL_VERIFICATION=true npm start
```

Register, copy the link out of the terminal, paste it into a browser, then sign in.
