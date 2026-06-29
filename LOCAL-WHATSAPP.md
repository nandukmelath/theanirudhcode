# Test the WhatsApp agent on the real number — locally, in ~10 min

Run the agent on your machine and expose it to Meta through a free **cloudflared**
tunnel. No Cloud Run deploy, no `gcloud auth login`. Great for testing on +91 6309786677
before you commit to a hosted deploy.

> You enter your own secrets into a local `.env` — never paste tokens into chat.

## 1. Fill `.env`
```bash
cp .env.whatsapp.example .env
```
Edit `.env` and set:
- `WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN` (24h test token is fine to start), `WHATSAPP_VERIFY_TOKEN=3279d2d88cdb6443b44c8615b288651fca4b0a81`
- `ANTHROPIC_API_KEY` (or `AI_PROVIDER=groq` + `GROQ_API_KEY`)
- `DATABASE_URL` = your Neon Postgres URL (the agent stores conversation memory + dedupe there; the `wa_` tables auto-create on boot)
- `JWT_SECRET` = any random string ≥16 chars
- Leave `NODE_ENV` unset (so the webhook accepts unsigned requests while you haven't set `WHATSAPP_APP_SECRET` yet). Set `WHATSAPP_ADMIN_NUMBER` to the doctor's WhatsApp for escalation pings.

Check it:
```bash
npm install
npm run wa:local        # pre-flight — confirms env + prints the exact next steps
```

## 2. Start the server (terminal 1)
```bash
npm start               # boots on http://localhost:3000, creates the wa_ tables
```

## 3. Open the tunnel (terminal 2)
```bash
# install once (Windows):  winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```
Copy the printed HTTPS URL, e.g. `https://random-words.trycloudflare.com`.
(ngrok works too: `ngrok http 3000` — needs a free ngrok account/authtoken.)

## 4. Wire the webhook in Meta
developers.facebook.com → your app → **WhatsApp → Configuration → Webhook → Edit**:
- **Callback URL:** `<tunnel-url>/webhook/whatsapp`
- **Verify token:** `3279d2d88cdb6443b44c8615b288651fca4b0a81`
- **Verify and save**, then under **Webhook fields** subscribe to **`messages`**.

## 5. Test on the real number
WhatsApp **+91 6309786677** from any phone:
- "hi" → welcome message + 3 tappable buttons (Prices / Book / Free guide), with read
  receipt + typing indicator.
- "how much is a consultation?" → Rs 2,999 + the booking link.
- "should I stop my metformin?" → declines to advise, invites a consultation, and the
  doctor's number gets a `🔔 Needs you` ping.

## Notes
- A free cloudflared URL **changes every restart** — re-paste it into Meta if you
  restart the tunnel. For a permanent URL, deploy to Cloud Run (see `WHATSAPP-AI-SETUP.md`).
- Tune answers without WhatsApp anytime: `npm run wa:chat`.
- Keep the laptop + both terminals running while testing — close them and the bot is offline.
