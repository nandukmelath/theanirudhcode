#!/usr/bin/env node
/**
 * Pre-flight for running the WhatsApp agent LOCALLY behind a cloudflared tunnel —
 * so you can test on the real number without a Cloud Run deploy.
 *
 *   node scripts/wa-local.mjs      (or: npm run wa:local)
 *
 * It checks your .env, then prints the exact tunnel command + Meta webhook values.
 * It does NOT start the server or the tunnel for you — you run those (two terminals).
 */
import dotenv from 'dotenv';
import { execSync } from 'node:child_process';
dotenv.config();

const E = process.env;
const provider = (E.AI_PROVIDER || 'anthropic').toLowerCase();
const ok = (b) => (b ? '✓' : '✗');
const rows = [];
let hardMissing = 0;

function req(name, present, note = '') { rows.push([ok(present), name, note]); if (!present) hardMissing++; }
function opt(name, present, note = '') { rows.push([present ? '✓' : '·', name, note]); }

req('DATABASE_URL', !!E.DATABASE_URL, 'conversation memory + dedupe (point at your Neon URL)');
req('JWT_SECRET', !!E.JWT_SECRET && E.JWT_SECRET.length >= 16, 'any random string ≥16 chars (server boot)');
req('WHATSAPP_PHONE_ID', !!(E.WHATSAPP_PHONE_ID || E.WHATSAPP_PHONE_NUMBER_ID), 'from Meta → WhatsApp → API Setup');
req('WHATSAPP_TOKEN', !!(E.WHATSAPP_TOKEN || E.WHATSAPP_ACCESS_TOKEN), '24h test token is fine to start');
req('WHATSAPP_VERIFY_TOKEN', !!(E.WHATSAPP_VERIFY_TOKEN), 'any string; paste the same into Meta');
if (provider === 'groq') req('GROQ_API_KEY', !!E.GROQ_API_KEY, 'AI_PROVIDER=groq');
else req('ANTHROPIC_API_KEY', !!E.ANTHROPIC_API_KEY, 'or set AI_PROVIDER=groq + GROQ_API_KEY');
opt('WHATSAPP_APP_SECRET', !!(E.WHATSAPP_APP_SECRET || E.WA_APP_SECRET), 'optional locally — without it, NODE_ENV must NOT be production');
opt('WHATSAPP_ADMIN_NUMBER', !!(E.WHATSAPP_ADMIN_NUMBER || E.WA_ADMIN_PHONE), "doctor's WhatsApp for escalation pings");

console.log(`\n  WhatsApp local test — pre-flight   (provider: ${provider})\n`);
for (const [m, n, note] of rows) console.log(`   ${m}  ${n.padEnd(22)} ${note}`);

const prodNoSecret = E.NODE_ENV === 'production' && !(E.WHATSAPP_APP_SECRET || E.WA_APP_SECRET);
if (prodNoSecret) console.log('\n  ⚠️  NODE_ENV=production but no WHATSAPP_APP_SECRET → the webhook will REJECT every message. Unset NODE_ENV for local testing, or set the app secret.');

let hasCloudflared = false;
try { execSync('cloudflared --version', { stdio: 'ignore' }); hasCloudflared = true; } catch {}

console.log('\n  ── Next steps ──────────────────────────────────────────────');
if (hardMissing) {
  console.log(`\n  ✗ ${hardMissing} required value(s) missing. Copy .env.whatsapp.example → .env, fill them, re-run.\n`);
  process.exit(1);
}
console.log(`
  1. Start the server (this terminal):
       npm start                         # boots on :3000, creates the wa_ tables

  2. Open the tunnel (a SECOND terminal):
     ${hasCloudflared ? '' : '   # install once:  winget install --id Cloudflare.cloudflared   (or https://github.com/cloudflare/cloudflared/releases)\n'}       cloudflared tunnel --url http://localhost:3000
     → copy the printed https URL, e.g.  https://random-words.trycloudflare.com

  3. Wire Meta (developers.facebook.com → your app → WhatsApp → Configuration → Webhook):
       Callback URL :  <that-https-url>/webhook/whatsapp
       Verify token :  ${E.WHATSAPP_VERIFY_TOKEN}
       → Verify and save, then subscribe to the "messages" field.

  4. From any phone, WhatsApp +91 6309786677 "hi"  → welcome + 3 buttons.
     "how much is a consultation?" → Rs 2,999 + booking link.

  Note: a free cloudflared tunnel URL changes every restart — re-paste it into Meta if
  you restart. For a stable URL, deploy to Cloud Run (see WHATSAPP-AI-SETUP.md).
`);
