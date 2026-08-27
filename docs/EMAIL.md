# Email verification

RocksCord confirms email addresses before letting an account sign in. This page covers the
one account you need to create, what it costs (nothing), and how to check it works.

**Time: about 10 minutes. No credit card, no domain name.**

---

## What it does

Registering creates the account and sends a link, but returns **no session** — there is
nothing to sign in with until the address is confirmed. Trying to sign in first gives:

```json
{"error":{"code":"EMAIL_NOT_VERIFIED","message":"Confirm your email address before signing in"}}
```

The app turns that into a "check your inbox" screen with a resend button, whether it was
reached by registering or by signing in to an old unconfirmed account.

Clicking the link confirms the address and shows a plain confirmation page. Links are
single-use, expire after 24 hours, and are replaced whenever a new one is sent.

---

## Without a provider

**The app works with no email account at all.** Local development, the test suite, and the
packaged desktop build all run unchanged.

With nothing configured, the transport falls back to printing the link to the server log:

```
------------------------------------------------------------------------
  EMAIL (not sent -- no provider configured)
  To:      friend@example.com
  Subject: Confirm your RocksCord email address
  Link:    http://localhost:4000/api/auth/verify-email?token=eOu08KcN...
------------------------------------------------------------------------
```

and verification is **not enforced** — registration signs you straight in, as it always
did.

That inference is deliberate. The desktop build runs its own server on the user's machine
with no way to send anything, so requiring a click on a link that could never arrive would
lock people out of their own computer. Set `REQUIRE_EMAIL_VERIFICATION=true` to demand it
anyway (useful for testing the flow locally — you copy the link out of the terminal).

---

## Why Brevo

The requirement that eliminates almost everything: **sending to addresses you do not
control, without owning a domain.** Your friends' addresses are not yours, and a domain
costs money.

| Provider | Free tier | Sends to anyone? | Verdict |
|---|---|---|---|
| **Brevo** | 300/day, forever | Yes, after verifying one sender address | **Used here** |
| Resend | 3,000/month | **No** — only your own address until you verify a domain | Unusable for this |
| Mailgun | Trial, then paid | Sandbox mode is limited to 5 authorised recipients | Unusable for this |
| SendGrid | 100/day | Yes | Workable, but signup screening rejects a lot of new accounts |
| Gmail SMTP | 500/day | Yes | Works, but needs an app password and mixes with your personal mail |

300 messages a day is roughly 300 new accounts a day. For a project shared with friends
that limit will never be reached.

---

## Setup

### 1. Create a Brevo account

Sign up at **[brevo.com](https://www.brevo.com)**. The free plan is the default; no card is
requested.

### 2. Verify a sender address

**Senders, Domains & Dedicated IPs → Senders → Add a sender.**

Use an address you can open — your own Gmail is fine. Brevo emails it a confirmation link;
click it. This is what lets you send without owning a domain, and it is the step people
skip and then wonder why every send is rejected.

### 3. Create an API key

**SMTP & API → API Keys → Generate a new API key.**

Copy it now — it is shown once.

### 4. Set two variables

On **Render**: your service → **Environment** → add both, then save. Render restarts the
service automatically; there is no redeploy to trigger.

```
EMAIL_API_KEY=xkeysib-...
EMAIL_FROM=the-address-you-verified@gmail.com
```

`EMAIL_FROM` **must** be the address from step 2. Anything else is rejected by Brevo.

Locally, put the same two lines in `.env`.

That is all. Verification switches itself on as soon as a key is present.

### 5. Check it

```bash
curl https://your-app.onrender.com/api/auth/config
```

```json
{"allowRegistration":true,"requireEmailVerification":true, ...}
```

`requireEmailVerification: true` means the key was read and mail can be sent. Then register
a throwaway account through the UI and confirm the email arrives.

---

## Settings

| Variable | Default | What it does |
|---|---|---|
| `EMAIL_API_KEY` | — | Brevo API key. Setting it turns verification on |
| `EMAIL_FROM` | — | Sender address, verified with Brevo. Required alongside the key |
| `EMAIL_FROM_NAME` | `RocksCord` | Display name on the message |
| `EMAIL_DRIVER` | `auto` | `auto`, `brevo`, or `console`. `auto` picks Brevo when a key is present |
| `REQUIRE_EMAIL_VERIFICATION` | inferred | Overrides the inference in either direction |
| `EMAIL_VERIFICATION_TTL_SECONDS` | `86400` | How long a link stays valid |

---

## Existing accounts

The migration marks every account created before this feature as verified, using its
original creation date.

They were made when no confirmation was ever asked for, so there is no address to
re-confirm and no link they could be expected to still have. Leaving them unverified would
lock out everyone on a running deployment — including you — the moment the migration ran.

The same applies to the seeded demo accounts: they are created pre-verified, because their
addresses are fictional and no link would ever arrive.

---

## Troubleshooting

**`requireEmailVerification` is still `false`**
The key is not reaching the process. On Render, confirm the variable is on the service
itself (not a linked environment group) and that the restart finished.

**The service will not start: "EMAIL_FROM is required"**
A key is set but no sender address. Set both, or neither.

**Logs show `Brevo rejected the message (HTTP 400): ... sender not valid`**
`EMAIL_FROM` is not the address you verified in step 2, or you never clicked Brevo's own
confirmation link.

**Nothing arrives, and nothing appears in the logs**
Check the register response. `{"verificationRequired":true}` means the account was created
and a send was attempted. A send failure during registration is logged at error level and
does **not** fail the request — the account is real, and the resend button will retry it.

**It lands in spam**
Expected for a new sender with no domain reputation, especially the first message to a
given provider. The app's own screen tells people to check spam. Marking it "not spam" once
usually fixes it for that recipient. Owning a domain and setting up SPF/DKIM is the real
fix, and it is not free.

**A friend clicked the link and got "already used"**
Some mail providers pre-fetch links to scan them. If the account ended up verified, the
page reports success rather than an error, so this is usually invisible. A genuine
"already used" means the link was replaced by a newer one — use the most recent email.

**Testing the whole flow locally**

```bash
REQUIRE_EMAIL_VERIFICATION=true npm start
```

Register, copy the link out of the terminal, paste it into a browser, then sign in. No
provider needed.
