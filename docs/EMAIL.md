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

Two requirements knock out almost everything:

1. **Send to addresses you do not own, without owning a domain.** Your users' addresses
   are not yours, and a domain costs money.
2. **Reach the provider over HTTPS.** Render's free instances
   [block outbound SMTP on ports 25, 465 and 587](https://render.com/changelog/free-web-services-will-no-longer-allow-outbound-traffic-to-smtp-ports).
   No SMTP relay works there at all, whatever the credentials — the symptom is a clean
   configuration that hangs and times out.

| Provider | Free allowance | Transport | Emails anyone? | Gatekeeping |
|---|---|---|---|---|
| **SMTP2GO** | 1,000/mo, 200/day, 25/hour | HTTPS | Yes | Confirm one sender address |
| Brevo | 300/day | HTTPS | Yes | New accounts held for manual approval |
| Resend | 3,000/mo | HTTPS | **No**, not without a domain | Instant, once a domain is verified |
| SMTP (Gmail) | 500/day | SMTP | Yes | None — but blocked on Render free |

**Use SMTP2GO.** It is the only one that clears both requirements with nothing to wait for.

### Why not the others

**SMTP / Gmail** works perfectly on your own machine, on a paid Render instance, and on
hosts that permit outbound SMTP. On Render's free tier it cannot work at all. The driver
detects that case and says so rather than reporting a timeout.

**Brevo** holds new accounts before permitting any transactional send:

```
HTTP 403 — "Unable to send email. Your SMTP account is not yet activated.
            Please contact us at contact@brevo.com to request activation"
```

Approval takes a day or so and is sometimes declined. Fine once granted; not something to
depend on today.

**Resend** is the nicest of the four *if you own a domain*. Without one it may only send
from `onboarding@resend.dev`, and mail from that address is delivered **only to the address
the Resend account was registered with**. It is a sandbox, not a starter tier — and it
fails deceptively, because your own test arrives and every real user's email vanishes. The
driver detects that specific rejection and names it.

---

## Setup: SMTP2GO (recommended)

No domain, no approval queue, works on hosts that block SMTP. About five minutes.

### 1. Sign up

**[smtp2go.com](https://www.smtp2go.com)** — the free plan is permanent and takes no card.

### 2. Verify a sender address

**Sending → Verified Senders → Add Sender → Single Sender Email.**

Use an address you can open; your own Gmail is fine. SMTP2GO emails it a link — click it.
A *single email address* is enough here; you do not need a domain. Skipping the click is
what causes every send to be refused.

### 3. Create an API key

**Sending → API Keys → Add API Key**, with permission to send email.

Keys look like `api-` followed by 32 characters. Copy it — it is shown once.

### 4. Set two variables

On **Render**: your service → **Environment** → add both, then save. Render restarts the
service by itself; there is no redeploy to trigger.

```
EMAIL_API_KEY=api-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
EMAIL_FROM=the-address-you-verified@gmail.com
```

The driver is chosen from the `api-` prefix, so `EMAIL_DRIVER` can stay `auto`. Delete any
`SMTP_*` variables you set earlier — they are ignored when a key is present, but leaving
them is confusing.

### 5. Check it

```bash
npm run test:email -- you@gmail.com
```

Then confirm the server picked it up:

```bash
curl.exe https://your-app.onrender.com/api/auth/config
```

`"requireEmailVerification":true` means it did.

> **Watch the hourly cap.** Until a domain is verified, SMTP2GO allows 25 messages an
> hour. Ordinary sign-ups will never approach that; repeatedly testing resends might.

---

## Setup: SMTP (Gmail)

Right for local development, a paid instance, or any host that permits outbound SMTP.
**It cannot work on Render's free tier.**

1. Turn on 2-Step Verification: **[myaccount.google.com/security](https://myaccount.google.com/security)**.
2. Create an app password: **[myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)**.
   Sixteen characters, shown once. This is not your Google password and can be revoked on
   its own.
3. Set:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASSWORD=the app password
```

`EMAIL_FROM` defaults to `SMTP_USER`. Use port 587 or 465; port 25 is blocked essentially
everywhere.

---

## Setup: Brevo

1. Sign up at **[brevo.com](https://www.brevo.com)**.
2. **[Senders](https://app.brevo.com/senders/list)** → **Add a sender**, then click the
   link Brevo emails to that address.
3. **[API keys](https://app.brevo.com/settings/keys/api)** → generate one (`xkeysib-…`).
4. Set `EMAIL_API_KEY` and `EMAIL_FROM`.

If sends return **403 not activated**, the account is still awaiting approval.

---

## Setup: Resend

**Only worth doing if you own a domain.**

1. Sign up at **[resend.com](https://resend.com)**.
2. **Domains** → **Add Domain**, then add the DNS records at your registrar.
3. **API Keys** → create one (`re_…`).
4. Set `EMAIL_API_KEY` and an `EMAIL_FROM` at that domain.

---

## Settings

| Variable | Default | What it does |
|---|---|---|
| `EMAIL_DRIVER` | `auto` | `auto`, `smtp2go`, `smtp`, `brevo`, `resend`, `console` |
| `SMTP_HOST` | — | e.g. `smtp.gmail.com`. Setting it selects SMTP |
| `SMTP_PORT` | `587` | 587 for STARTTLS, 465 for implicit TLS. Never 25 |
| `SMTP_USER` | — | The mailbox address |
| `SMTP_PASSWORD` | — | App password, not the account password |
| `EMAIL_API_KEY` | — | SMTP2GO (`api-…`), Resend (`re_…`) or Brevo (`xkeysib-…`) key |
| `EMAIL_FROM` | `SMTP_USER` | Sender address the provider will accept |
| `EMAIL_FROM_NAME` | `RocksCord` | Display name on the message |
| `REQUIRE_EMAIL_VERIFICATION` | inferred | Overrides the inference in either direction |
| `EMAIL_VERIFICATION_TTL_SECONDS` | `86400` | How long a link stays valid |

`auto` reads the credentials, in this order: SMTP2GO for an `api-` key, Resend for `re_`,
Brevo for any other key, SMTP if a host and credentials are set, otherwise the console. A
key wins over SMTP when both are present, since SMTP is the one more likely to be blocked
by the host.

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

**SMTP times out on Render: "Connection timeout"**
Render's free instances block outbound SMTP on 25, 465 and 587, so no relay can work there
whatever the credentials. Switch to SMTP2GO, or upgrade to a paid instance.

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
