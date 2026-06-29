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
- A **quick** tunnel URL (`cloudflared tunnel --url …`) changes every restart. For a
  **stable** URL you paste into Meta once, set up a named tunnel ↓.
- Tune answers without WhatsApp anytime: `npm run wa:chat`.
- Keep the laptop + both terminals running while testing — close them and the bot is offline.

---

# Stable named tunnel (URL never changes)

Gives a fixed `https://wa.theanirudhcode.com/webhook/whatsapp` — wire Meta once, restart
freely. Works because theanirudhcode.com is already on Cloudflare. One-time setup:

```bash
# 1. Log in (browser opens → pick the theanirudhcode.com zone)  ── YOUR action (OAuth)
cloudflared login

# 2. Create the tunnel — prints a UUID and writes a credentials .json to ~/.cloudflared
cloudflared tunnel create theanirudhcode-wa

# 3. Point a subdomain at it (creates the CNAME in Cloudflare DNS automatically)
cloudflared tunnel route dns theanirudhcode-wa wa.theanirudhcode.com

# 4. Make the config
cp cloudflared/config.example.yml cloudflared/config.yml
#    → edit cloudflared/config.yml: paste the UUID + the credentials-file path from step 2

# 5. Run it (terminal 2, instead of the quick tunnel)
npm run wa:tunnel
#    = cloudflared tunnel run --config cloudflared/config.yml theanirudhcode-wa
```

Now the webhook URL is permanent:
- **Meta → WhatsApp → Configuration → Callback URL:** `https://wa.theanirudhcode.com/webhook/whatsapp`
- Verify token: `3279d2d88cdb6443b44c8615b288651fca4b0a81` → subscribe `messages`. Never re-paste again.

### Auto-start on boot (so it survives restarts)
Install the tunnel as a Windows service (run an elevated terminal):
```bash
cloudflared service install --config "C:\Users\nandu\theanirudhcode\cloudflared\config.yml"
```
The tunnel then starts with Windows. To keep the **server** (`npm start`) always up too,
run it under pm2: `npm i -g pm2 && pm2 start server.js --name theanirudhcode && pm2 save`.
(Or just run both manually when you want the bot online — for a permanent always-on
setup, deploying to Cloud Run is cleaner; see `WHATSAPP-AI-SETUP.md`.)
