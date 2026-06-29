#!/usr/bin/env node
/**
 * Chat with the WhatsApp agent's brain in your terminal — no WhatsApp / Meta needed.
 * Uses whatever provider is configured (AI_PROVIDER + key); with no key it shows the
 * safe fallback path. Great for tuning answers + the knowledge base fast.
 *
 *   # Claude:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/wa-chat.mjs
 *   # Groq:
 *   AI_PROVIDER=groq GROQ_API_KEY=gsk_... node scripts/wa-chat.mjs
 *
 * Commands:  /reset  clear the conversation   |   /quit  exit
 */
import readline from 'node:readline';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const agent = require('../src/lib/ai-agent.js');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let history = [];

console.log(`\n  theanirudhcode — agent chat  (provider: ${agent.PROVIDER}, configured: ${agent.isConfigured()})`);
console.log(`  ${agent.PROVIDER === 'groq' ? 'model ' + agent.GROQ_MODEL : 'model ' + agent.MODEL}`);
console.log(`  type a message as a client would. /reset to clear, /quit to exit.\n`);

const ask = () => rl.question('client › ', async (line) => {
  const t = line.trim();
  if (t === '/quit' || t === '/exit') { rl.close(); return; }
  if (t === '/reset') { history = []; console.log('  (conversation cleared)\n'); return ask(); }
  if (!t) return ask();

  history.push({ role: 'user', content: t });
  const r = await agent.generateReply(history, 'Tester');
  history.push({ role: 'assistant', content: r.reply });

  console.log(`\nbot   › ${r.reply}`);
  const flag = r.escalate ? `  ⚠️ ESCALATE → doctor pinged, bot would go quiet` : '';
  console.log(`        [category: ${r.category}${flag}]\n`);
  ask();
});

ask();
rl.on('close', () => { console.log('\n  bye 👋\n'); process.exit(0); });
