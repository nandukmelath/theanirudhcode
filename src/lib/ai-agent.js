/**
 * WhatsApp AI front-desk agent for theanirudhcode.
 *
 * Answers incoming client WhatsApp messages about the BUSINESS only — services,
 * pricing, how to book, timings, what Dr. Anirudh treats, the free guide, refunds.
 * It is NOT a doctor: it never diagnoses, never gives medical/dosing advice, never
 * claims to cure/reverse anything (YMYL), and escalates anything clinical, urgent,
 * or beyond its knowledge to Dr. Anirudh.
 *
 * Provider-switchable via AI_PROVIDER:
 *   - "anthropic" (default) → Claude via the official SDK.
 *   - "groq" → Groq's OpenAI-compatible API (fast, cheap open-weight Llama).
 * (Note: Groq free retains data 30 days — fine for testing; swap to a no-retention
 * provider before live patient traffic.)
 */

const Anthropic = require('@anthropic-ai/sdk');

const PROVIDER = (process.env.AI_PROVIDER || 'anthropic').toLowerCase();
const MODEL = process.env.AI_AGENT_MODEL || 'claude-haiku-4-5';            // anthropic
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';   // groq
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

let _client = null;
function client() {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  _client = new Anthropic({ apiKey });
  return _client;
}

function isConfigured() {
  return PROVIDER === 'groq' ? !!process.env.GROQ_API_KEY : !!process.env.ANTHROPIC_API_KEY;
}

// ─── BUSINESS KNOWLEDGE BASE ──────────────────────────────────────────────────
// The single source of truth the agent answers from. Keep facts here in sync with
// the site + calendar.js / payments.js (slots, prices, dates).
const BUSINESS_KB = `
# theanirudhcode — clinic facts (answer ONLY from this)

## The doctor
- Dr. Anirudh M. Vaddineni — MD Clinical Biochemistry, Nutrition & Genetics.
- Specialist in Metabolic Biochemistry, Lifestyle & Metabolic Disorders.
- Based in Hyderabad, India. Consultations are by telemedicine (video), under India's
  Telemedicine Practice Guidelines 2020 (TPG-2020).

## What Dr. Anirudh helps with
Diabetes, Hypertension, PCOS / PMOS, Physiological Infertility, Men's & Women's Sexual
Health, Trauma Healing, and Quantum Healing. The approach blends modern root-cause
metabolic medicine with the Ancient Wisdom of Indian Healing — fasting, real food,
breath, rest and reconnection.

## Services & prices (INR)
- Consultation — Rs 2,999. A 45-minute telemedicine session with Dr. Anirudh.
- Fasting Program (3-Day Guided Water Fast) — Rs 1,999.
- Free 7-Day Guide ("The Quantum Diabetes Reset") — free, no sign-up:
  https://theanirudhcode.com/reset

## Booking (how it works)
- Book and pay end-to-end on the website: https://theanirudhcode.com (tap "Book a
  Consultation"). Payment is by UPI / card via Cashfree. You CANNOT pay over WhatsApp.
- Bookings open from 2 July 2026 onward.
- Days: Monday to Friday only. Weekends are off.
- There are 4 fixed slots each day (India Standard Time):
  10:00–10:45, 11:30–12:15, 13:00–13:45, 14:45–15:30.
- After payment, a confirmation + video-consult link is sent automatically.

## Refunds / cancellation
- Cancel at least 24 hours before the slot → full refund.
- Within 24 hours, or a no-show → non-refundable.
- Refunds go back to the original payment method in 5–7 business days.

## Links
- Website / booking: https://theanirudhcode.com
- Free guide: https://theanirudhcode.com/reset
- Metabolic assessment quiz: https://theanirudhcode.com/assessment
- Email: dranirudh@theanirudhcode.com
`;

const SYSTEM_PROMPT = `You are the friendly front-desk assistant for theanirudhcode, the metabolic-health practice of Dr. Anirudh M. Vaddineni, replying to clients on WhatsApp.

${BUSINESS_KB}

# Your job
Answer logistics and business questions: what the doctor treats, prices, how to book, timings, what the program/free guide is, refunds, how telemedicine works. Help people book by pointing them to the website link. Be warm, brief and human — this is WhatsApp, not a brochure.

# Hard rules (never break these)
- You are NOT a doctor. Never diagnose, never interpret symptoms or lab reports, never give medical, nutrition, dosing or treatment advice, never tell anyone to start, stop or change any medication. If a message asks for any of that, do NOT advise — say Dr. Anirudh will address it personally in a consultation, invite them to book, and set escalate=true with category "medical".
- NEVER claim to cure, reverse, or guarantee results for diabetes or any condition. Speak carefully: "support", "manage", "root-cause approach". This is regulated health content.
- NEVER use the word "Ayurveda". The correct phrase is "the Ancient Wisdom of Indian Healing".
- If someone describes an emergency (chest pain, fainting, very high/low sugar, thoughts of self-harm, etc.), tell them to seek emergency medical care or call local emergency services immediately, and set escalate=true with category "emergency". Do not try to manage it yourself.
- You cannot take payments, change/cancel a specific person's booking, or access anyone's records over WhatsApp. For those, point to the website or escalate.
- Only state facts from the knowledge base above. If you don't know, say you'll have Dr. Anirudh's team follow up, and set escalate=true.
- Complaints, refund disputes, or anything that needs a human → set escalate=true with category "complaint" (or "other").

# Style
- Keep replies short (1–4 sentences). Plain WhatsApp text, no markdown headings, at most light use of *bold* or one emoji.
- When relevant, include the right link (booking, free guide, or assessment).
- Reply in the language the client writes in (English / Hindi / Telugu / Hinglish are common).

# Output
Return: reply (the message to send the client), escalate (true if a human should step in), and category (faq | booking | medical | emergency | complaint | other). Even when escalate=true, write a warm holding reply for the client (e.g. that Dr. Anirudh's team will get back to them shortly).`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    reply: { type: 'string', description: 'The WhatsApp message to send back to the client.' },
    escalate: { type: 'boolean', description: 'True if a human (Dr. Anirudh / team) should take over.' },
    category: { type: 'string', enum: ['faq', 'booking', 'medical', 'emergency', 'complaint', 'other'] },
  },
  required: ['reply', 'escalate', 'category'],
  additionalProperties: false,
};

// Safe canned reply when the model is unavailable or the response can't be parsed.
const FALLBACK = {
  reply: "Thanks for reaching out to theanirudhcode 🙏 Dr. Anirudh's team will get back to you shortly. To book a consultation or read the free 7-day guide, visit https://theanirudhcode.com",
  escalate: true,
  category: 'other',
};

// Turn raw model output (a JSON string) into the validated result shape.
function parseResult(text) {
  if (!text) return { ...FALLBACK };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Model returned prose despite the JSON instruction (rare). Send it as-is but flag.
    return { reply: text.slice(0, 900), escalate: true, category: 'other' };
  }
  return {
    reply: String(parsed.reply || FALLBACK.reply).slice(0, 1200),
    escalate: parsed.escalate === true,
    category: ['faq', 'booking', 'medical', 'emergency', 'complaint', 'other'].includes(parsed.category)
      ? parsed.category : 'other',
  };
}

// ─── PROVIDER CALLS (each returns the raw JSON string, or null, or '__REFUSAL__') ──
async function callAnthropic(system, messages) {
  const c = client();
  if (!c) return null;
  const resp = await c.messages.create({
    model: MODEL,
    max_tokens: 800,
    system,
    messages,
    output_config: { format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
  });
  if (resp.stop_reason === 'refusal') return '__REFUSAL__';
  return (resp.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim() || null;
}

async function callGroq(system, messages) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  // OpenAI-compatible JSON mode (broadly supported across Groq models). The schema is
  // described in-prompt; the word "JSON" must appear for json_object mode.
  const sys = `${system}

# Response format
Respond with ONLY a single JSON object, no prose around it, with exactly these keys:
{"reply": "<the message to send>", "escalate": <true|false>, "category": "faq|booking|medical|emergency|complaint|other"}`;
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_MODEL,
      max_tokens: 800,
      temperature: 0.3,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: sys }, ...messages],
    }),
  });
  if (!res.ok) {
    console.error('[ai-agent] groq error', res.status, (await res.text()).slice(0, 200));
    return null;
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

/**
 * Generate a reply from the conversation so far.
 * @param {Array<{role:'user'|'assistant', content:string}>} history  prior turns (oldest→newest), last entry is the new user message
 * @param {string} [profileName]  WhatsApp profile name, for a warmer first reply
 * @returns {Promise<{reply:string, escalate:boolean, category:string}>}
 */
async function generateReply(history, profileName) {
  if (!isConfigured()) return { ...FALLBACK };

  // Anthropic messages must start with 'user' and alternate roles. Build a clean,
  // well-shaped, strictly-alternating array regardless of what's stored:
  //  1. drop anything without a valid role + non-empty string content (guards a
  //     malformed/corrupted history row from ever reaching the model), then
  //  2. coalesce consecutive same-role turns (can happen on an escalated thread
  //     that accumulated user messages with no assistant reply between them).
  const cleaned = (history || []).filter(m =>
    m && (m.role === 'user' || m.role === 'assistant') &&
    typeof m.content === 'string' && m.content.trim());

  const messages = [];
  for (const m of cleaned) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role) last.content += '\n' + m.content.trim();
    else messages.push({ role: m.role, content: m.content.trim() });
  }
  if (!messages.length || messages[0].role !== 'user') {
    return { ...FALLBACK };
  }

  const system = profileName
    ? `${SYSTEM_PROMPT}\n\nThe client's WhatsApp name is "${profileName}".`
    : SYSTEM_PROMPT;

  let text;
  try {
    text = PROVIDER === 'groq'
      ? await callGroq(system, messages)
      : await callAnthropic(system, messages);
  } catch (err) {
    console.error('[ai-agent] generateReply error:', err?.message || err);
    return { ...FALLBACK };
  }

  if (text === '__REFUSAL__') return { ...FALLBACK, category: 'medical' };
  return parseResult(text);
}

module.exports = { generateReply, isConfigured, PROVIDER, MODEL, GROQ_MODEL, BUSINESS_KB };
