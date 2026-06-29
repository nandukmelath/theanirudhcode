# WhatsApp AI Front-Desk Agent — Setup

An AI agent that auto-answers client WhatsApp messages for theanirudhcode — services,
prices, booking, timings, the free guide, refunds — and escalates anything medical,
urgent, or beyond its knowledge to Dr. Anirudh. Built on the live Cloud Run / Express
backend.

## What got built

| Piece | File |
|---|---|
| AI brain (Claude + business knowledge + medical/YMYL guardrails) | `src/lib/ai-agent.js` |
| Inbound webhook (verify, signature, dedupe, memory, escalate) | `src/controllers/whatsapp.js` |
| Outbound send (already existed) | `src/lib/whatsapp.js` |
| Conversation memory + dedupe tables | `prisma/schema.prisma` (`wa_conversations`, `wa_processed_messages`) + idempotent migration in `server.js` |
| Wiring (raw body, route, origin-gate exemption) | `server.js` |

**Endpoint:** `https://theanirudhcode.com/webhook/whatsapp` (and the Cloud Run `*.run.app` URL).
- `GET` → Meta verification handshake.
- `POST` → incoming messages → AI reply.

## How it behaves

1. Client messages the WhatsApp Business number.
2. Bot loads the recent conversation, asks Claude for a reply grounded **only** in the
   clinic knowledge base (`BUSINESS_KB` in `ai-agent.js`).
3. Sends a short, warm reply. Nudges to the booking link when relevant.
4. **Escalation** — if the message is medical, an emergency, a complaint, or anything
   it can't answer, it sends a holding reply, pings Dr. Anirudh on WhatsApp, and goes
   **quiet** on that chat so it never talks over the doctor.

**Guardrails (hard-coded in the system prompt):** never diagnoses or gives
medical/dosing advice; never claims to cure/reverse diabetes (regulated YMYL content);
never says "Ayurveda" (uses "Ancient Wisdom of Indian Healing"); routes emergencies to
emergency care; cannot take payments over chat (points to the website).

## Required environment variables (set in Cloud Run)

| Var | What | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | The Claude API key the agent uses | console.anthropic.com → API keys |
| `WHATSAPP_PHONE_ID` | WhatsApp Business phone-number ID | Meta dashboard → WhatsApp → API setup |
| `WHATSAPP_TOKEN` | Permanent access token | Meta → System User → permanent token |
| `WHATSAPP_VERIFY_TOKEN` | Any random string you choose; you paste the same one into Meta | make one up (e.g. `openssl rand -hex 16`) |
| `WHATSAPP_APP_SECRET` | Meta App Secret — verifies webhook signatures | Meta → App → Settings → Basic → App Secret |
| `WHATSAPP_ADMIN_NUMBER` | Dr. Anirudh's WhatsApp number for escalation pings (e.g. `9198XXXXXXXX`) | — |
| `AI_AGENT_MODEL` | *(optional)* model override. Default `claude-haiku-4-5` (fast + cheap, right for FAQ). Set `claude-opus-4-8` for max quality. | — |

> **`WHATSAPP_APP_SECRET` is required in production.** With `NODE_ENV=production` and no
> app secret set, the webhook **rejects every inbound message (403)** and logs a startup
> warning — so a missing secret fails safe (no unsigned messages get processed) rather
> than failing open. In non-production it accepts unsigned requests (with a warning) so
> you can test locally. The webhook is also rate-limited to **30 messages/min per sender**
> (each message is a paid Claude call), and `ANTHROPIC_API_KEY` being unset logs a startup
> warning and makes the bot escalate every message instead of auto-replying.

## Meta setup (one-time)

1. **Meta for Developers** → create/open an App → add the **WhatsApp** product.
2. Get a phone number (test number is free; add your business number for production).
3. Copy the **Phone number ID** → `WHATSAPP_PHONE_ID`.
4. Create a **System User** with a **permanent** token (the temporary 24h token expires) →
   `WHATSAPP_TOKEN`.
5. **Configure the webhook:**
   - Callback URL: `https://theanirudhcode.com/webhook/whatsapp`
   - Verify token: the same string you set in `WHATSAPP_VERIFY_TOKEN`.
   - Click **Verify and save** (Meta calls the `GET` endpoint — it must return 200).
   - Under **Webhook fields**, subscribe to **`messages`**.
6. App → Settings → Basic → copy **App Secret** → `WHATSAPP_APP_SECRET`.

## Deploy

```bash
gcloud config set account dranirudh@theanirudhcode.com
gcloud run deploy theanirudhcode --source . --region asia-south1 --project animated-vector-496120-b2 \
  --set-env-vars ANTHROPIC_API_KEY=...,WHATSAPP_PHONE_ID=...,WHATSAPP_TOKEN=...,WHATSAPP_VERIFY_TOKEN=...,WHATSAPP_APP_SECRET=...,WHATSAPP_ADMIN_NUMBER=...
```

(Or set the env vars in the Cloud Run console → Edit & deploy new revision → Variables.)
The `wa_conversations` / `wa_processed_messages` tables are created automatically by the
idempotent migration on boot — no manual DB step.

## Test

1. After the webhook verifies in Meta, send a WhatsApp to the business number:
   *"What are your consultation timings and price?"* → expect a reply about Rs 2,999,
   45-min telemedicine, Mon–Fri 4 slots, with the booking link.
2. Send something medical: *"Should I stop my metformin?"* → expect a polite
   "Dr. Anirudh will address that personally" + a booking nudge, and Dr. Anirudh gets a
   `🔔 Needs you` WhatsApp.

## Tuning

- **Edit what it knows / how it talks:** `BUSINESS_KB` and `SYSTEM_PROMPT` in
  `src/lib/ai-agent.js`. Keep prices/slots in sync with `payments.js` / `calendar.js`.
- **Re-engage an escalated chat:** set `escalated = false` for that phone in
  `wa_conversations` (the bot stays silent while it's `true`).
