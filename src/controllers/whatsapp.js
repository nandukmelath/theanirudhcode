/**
 * WhatsApp Business Cloud API — inbound webhook + AI auto-responder.
 *
 * Meta calls this endpoint when a client messages the business number:
 *   GET  /webhook/whatsapp   → one-time verification handshake (hub.challenge)
 *   POST /webhook/whatsapp   → incoming messages + delivery statuses
 *
 * Flow for a client text message:
 *   verify signature → dedupe by message id → load conversation memory →
 *   ai-agent.generateReply() → send reply via whatsapp.sendText() → persist memory.
 *   If the agent escalates (medical / emergency / complaint / unknown), the bot
 *   sends a warm holding reply, pings Dr. Anirudh on WhatsApp, and goes quiet on
 *   that thread so it never talks over the doctor.
 *
 * Mounted in server.js with express.raw() so the X-Hub-Signature-256 HMAC can be
 * verified against the exact bytes Meta sent.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();

const prisma = require('../lib/prisma');
const wa = require('../lib/whatsapp');
const agent = require('../lib/ai-agent');

const MAX_HISTORY = 12;          // turns kept per conversation (bounds token cost)
const RAW_LIMIT = 200_000;       // ignore absurdly large webhook bodies

function verifyToken() {
  return process.env.WHATSAPP_VERIFY_TOKEN || process.env.WA_VERIFY_TOKEN;
}
function appSecret() {
  return process.env.WHATSAPP_APP_SECRET || process.env.WA_APP_SECRET;
}

// ─── GET: Meta webhook verification ───────────────────────────────────────────
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && verifyToken() && token === verifyToken()) {
    console.log('[WhatsApp] Webhook verified');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ─── Signature check (X-Hub-Signature-256 = HMAC-SHA256(rawBody, appSecret)) ───
function signatureValid(req) {
  const secret = appSecret();
  if (!secret) {
    // No app secret configured. In PRODUCTION this is unsafe — an unsigned webhook
    // could be forged to inject messages or fake escalations — so reject. In dev we
    // accept (with a warning) so the integration can be exercised before the secret
    // is wired. (We reject only the webhook here, rather than crashing the whole
    // server, because this same Express app also serves the live site + /api.)
    if (process.env.NODE_ENV === 'production') {
      console.error('[WhatsApp] WHATSAPP_APP_SECRET not set in production — rejecting unsigned webhook');
      return false;
    }
    console.warn('[WhatsApp] WHATSAPP_APP_SECRET not set — skipping signature check (non-production)');
    return true;
  }
  const sig = req.get('x-hub-signature-256');
  if (!sig) return false;
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body || ''), 'utf8');
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ─── POST: incoming events ────────────────────────────────────────────────────
router.post('/', (req, res) => {
  // Reject oversized payloads outright.
  if (Buffer.isBuffer(req.body) && req.body.length > RAW_LIMIT) return res.sendStatus(413);

  if (!signatureValid(req)) {
    console.warn('[WhatsApp] Invalid webhook signature — rejected');
    return res.sendStatus(403);
  }

  // ACK Meta immediately (it retries on slow/non-200 responses and can duplicate
  // deliveries). Process the message after responding.
  res.sendStatus(200);

  let payload;
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (e) {
    console.warn('[WhatsApp] Unparseable webhook body');
    return;
  }

  handleWebhook(payload).catch(err =>
    console.error('[WhatsApp] handleWebhook error:', err?.message || err));
});

async function handleWebhook(payload) {
  if (!payload || payload.object !== 'whatsapp_business_account') return;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      const profileName = contacts[0]?.profile?.name || null;

      for (const msg of value.messages || []) {
        // Ignore delivery/read statuses (those arrive under value.statuses, not here).
        await handleMessage(msg, profileName).catch(err =>
          console.error('[WhatsApp] handleMessage error:', err?.message || err));
      }
    }
  }
}

async function handleMessage(msg, profileName) {
  const from = msg.from;                 // sender wa_id, e.g. "9198..."
  const msgId = msg.id;                  // wamid... — unique per message
  if (!from || !msgId) return;

  // Dedupe: Meta can deliver the same message more than once. The PRIMARY KEY makes
  // the INSERT atomic — a duplicate delivery loses the race and gets P2002, which we
  // swallow. Any OTHER error (DB down, timeout) is a real operational failure: log it
  // loudly instead of masking it as "already handled", then skip (we can't guarantee
  // idempotency without the dedupe row, and Meta will retry).
  try {
    await prisma.waProcessedMessage.create({ data: { id: msgId } });
  } catch (e) {
    if (e?.code !== 'P2002') {
      console.error('[WhatsApp] dedupe write failed (message skipped):', e?.message || e);
    }
    return;
  }

  // Blue ticks + "typing…" the moment we pick the message up — makes the bot feel
  // instant and alive while the model thinks. Fire-and-forget (non-critical).
  wa.markReadTyping(msgId).catch(() => {});

  // Only auto-handle text. For media/other, send a gentle nudge and escalate-free.
  let text;
  if (msg.type === 'text') {
    text = msg.text?.body?.trim();
  } else if (msg.type === 'button') {
    text = msg.button?.text?.trim();
  } else if (msg.type === 'interactive') {
    text = (msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || '').trim();
  }

  if (!text) {
    await wa.sendText(from,
      "Thanks for your message! I can help over text 🙂 — ask me about consultations, the fasting program, timings or our free guide. To book, visit https://theanirudhcode.com");
    return;
  }

  const convo = await loadConversation(from);
  const history = Array.isArray(convo.history) ? convo.history : [];
  const isFirstContact = history.length === 0;

  // Once a thread is escalated, the bot stays silent so it never talks over Dr.
  // Anirudh / the team. We still record the message for context.
  history.push({ role: 'user', content: text });

  if (convo.escalated) {
    await saveConversation(from, trim(history), true);
    return;
  }

  // Dope first impression: a brand-new chat that opens with a bare greeting gets a
  // warm welcome + 3 tappable quick-reply buttons (tapping sends the title back as
  // text, which the agent then answers). Real questions skip straight to the AI.
  if (isFirstContact && isGreeting(text)) {
    const first = profileName ? ' ' + profileName.split(' ')[0] : '';
    const welcome = `Hi${first}! 👋 I'm Dr. Anirudh's assistant at *theanirudhcode*. I can help with consultations, our fasting program, timings, and the free 7-day guide. What would you like to know?`;
    await wa.sendButtons(from, welcome, [
      { id: 'prices', title: '💰 Prices' },
      { id: 'book', title: '📅 Book a consult' },
      { id: 'guide', title: '📖 Free 7-day guide' },
    ]);
    history.push({ role: 'assistant', content: welcome });
    await saveConversation(from, trim(history), false);
    return;
  }

  const result = await agent.generateReply(history, profileName);

  await wa.sendText(from, result.reply);
  history.push({ role: 'assistant', content: result.reply });

  await saveConversation(from, trim(history), result.escalate);

  if (result.escalate) {
    await notifyDoctor({ from, profileName, text, category: result.category }).catch(() => {});
  }
}

function trim(history) {
  return history.slice(-MAX_HISTORY);
}

// A bare greeting (not a real question) → show the welcome menu instead of the AI.
function isGreeting(text) {
  const t = text.toLowerCase().trim().replace(/[!.?]+$/, '');
  if (t.length <= 4) return true; // "hi", "hey", "yo", "hii"
  return /^(hi+|hey+|hello+|hai+|yo|start|menu|namaste|namaskar|namaskaram|vanakkam|salaam|hola|good\s*(morning|afternoon|evening)|hi there|hello there)$/.test(t);
}

async function loadConversation(phone) {
  const row = await prisma.waConversation.findUnique({ where: { phone } });
  if (!row) return { history: [], escalated: false };
  // Defend against a malformed/corrupted history (manual SQL edit, backup restore,
  // older schema): if it isn't an array of well-shaped turns, reset it rather than
  // feeding a bad shape to the model.
  const ok = Array.isArray(row.history) && row.history.every(m =>
    m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
  return { history: ok ? row.history : [], escalated: !!row.escalated };
}

async function saveConversation(phone, history, escalated) {
  try {
    await prisma.waConversation.upsert({
      where: { phone },
      update: { history, escalated, lastInbound: new Date() },
      create: { phone, history, escalated, lastInbound: new Date() },
    });
  } catch (e) {
    // The reply was already sent and Meta already got its 200, so it won't retry —
    // a failed save means this turn drops out of the thread's memory. Log loudly so
    // it's visible in Cloud Run logs rather than silently losing context.
    console.error('[WhatsApp] CRITICAL: failed to save conversation for', phone, ':', e?.message || e);
  }
}

// Ping Dr. Anirudh (WhatsApp admin number) so a human can take over the thread.
async function notifyDoctor({ from, profileName, text, category }) {
  const flag = category === 'emergency' ? '🚨 EMERGENCY' : '🔔 Needs you';
  const body =
`◆ *WhatsApp lead — ${flag}*

From: ${profileName ? profileName + ' ' : ''}(+${from})
Topic: ${category}

They said:
"${text.slice(0, 400)}"

The assistant sent a holding reply and has paused on this chat — reply to them directly on WhatsApp to take over.`;
  await wa.sendText(
    process.env.WHATSAPP_ADMIN_NUMBER || process.env.WA_ADMIN_PHONE || process.env.ADMIN_WHATSAPP,
    body
  );
}

module.exports = router;
