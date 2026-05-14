// Minimal WhatsApp ping for doctor escalations.
// Uses Meta Cloud API. Falls back to console.log if env not configured.
const axios = require('axios');

async function pingDoctor({ title, body, link }) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const to = process.env.DOCTOR_WHATSAPP;
  if (!token || !phoneId || !to) {
    console.log('[whatsapp:ping]', { title, body, link, note: 'env not configured — log only' });
    return { ok: false, reason: 'env_missing' };
  }
  const text = [title, body, link].filter(Boolean).join('\n\n');
  try {
    const { data } = await axios.post(
      `https://graph.facebook.com/v20.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return { ok: true, messageId: data?.messages?.[0]?.id };
  } catch (err) {
    return { ok: false, reason: err.response?.data?.error?.message || err.message };
  }
}

module.exports = { pingDoctor };
