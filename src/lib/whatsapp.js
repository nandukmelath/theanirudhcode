/**
 * WhatsApp Business Cloud API
 * Meta Cloud API — free 1000 conversations/month
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */

const axios = require('axios');

const WA_BASE = 'https://graph.facebook.com/v19.0';

function isConfigured() {
  return !!(process.env.WA_PHONE_NUMBER_ID && process.env.WA_ACCESS_TOKEN);
}

// Format Indian phone numbers → international format (91XXXXXXXXXX)
function formatPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `91${digits}`;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  if (digits.length === 11 && digits.startsWith('0')) return `91${digits.slice(1)}`;
  if (digits.length >= 10) return digits;
  return null;
}

async function sendText(to, body) {
  if (!isConfigured()) {
    console.log(`[WhatsApp NOT CONFIGURED] To: ${to}\n${body}\n`);
    return false;
  }
  const phone = formatPhone(to);
  if (!phone) { console.warn('[WhatsApp] Invalid phone:', to); return false; }

  try {
    await axios.post(
      `${WA_BASE}/${process.env.WA_PHONE_NUMBER_ID}/messages`,
      { messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'text', text: { preview_url: false, body } },
      { headers: { Authorization: `Bearer ${process.env.WA_ACCESS_TOKEN}`, 'Content-Type': 'application/json' } }
    );
    console.log(`[WhatsApp] ✓ Sent to ${phone}`);
    return true;
  } catch (err) {
    console.error('[WhatsApp] Error:', err.response?.data?.error?.message || err.message);
    return false;
  }
}

// ─── NOTIFICATION TEMPLATES ───────────────────────────────────────────────────

// 1. OTP via WhatsApp
async function sendOtpWhatsApp(phone, name, otp) {
  const msg =
`◆ *theanirudhcode*

Hello ${name.split(' ')[0]} 👋

Your verification code is:

*${otp}*

This code expires in *15 minutes*. Do not share it with anyone.`;
  return sendText(phone, msg);
}

// 2. Booking confirmation to patient (full details)
async function sendBookingConfirmation(phone, name, appointment) {
  const msg =
`◆ *theanirudhcode*

Hello ${name.split(' ')[0]},

✅ Your consultation has been *confirmed!*

📅 Date: *${appointment.date}*
🕐 Time: *${appointment.time_start} – ${appointment.time_end}* (IST)
📋 Status: Confirmed
🩺 Health Concerns: ${appointment.health_concerns || 'Not specified'}
🎯 Goals: ${appointment.goals || 'Not specified'}
📝 Medical History: ${appointment.medical_history || 'Not provided'}

Dr. Anirudh will be with you at the scheduled time. If you need to reschedule or cancel, please do so at least 24 hours in advance.

_theanirudhcode — Heal the Real You_`;
  return sendText(phone, msg);
}

// 3. Admin notification — new booking (full details)
async function sendAdminNewBooking(appointment, patient) {
  if (!process.env.WA_ADMIN_PHONE) return false;
  const msg =
`◆ *New Booking Alert*

👤 Patient: *${patient.name}*
📧 Email: ${patient.email}
📱 Phone: ${patient.phone || 'Not provided'}

📅 Date: *${appointment.date}*
🕐 Time: *${appointment.time_start} – ${appointment.time_end}*

🩺 Concerns: ${appointment.health_concerns || 'Not specified'}
🎯 Goals: ${appointment.goals || 'Not specified'}
📝 Medical History: ${appointment.medical_history || 'Not provided'}

View in dashboard: https://theanirudhcode.com/portal-management`;
  return sendText(process.env.WA_ADMIN_PHONE, msg);
}

// 4. Booking cancellation to patient
async function sendCancellationNotice(phone, name, appointment) {
  const msg =
`◆ *theanirudhcode*

Hello ${name.split(' ')[0]},

Your appointment on *${appointment.date}* at *${appointment.time_start}* has been *cancelled*.

To book a new appointment, visit our website or reply to this message.

_theanirudhcode — Heal the Real You_`;
  return sendText(phone, msg);
}

// 5. Appointment completion — thank you message
async function sendCompletionMessage(phone, name) {
  const msg =
`◆ *theanirudhcode*

Hello ${name.split(' ')[0]},

Thank you for your consultation with Dr. Anirudh! 🙏

We hope you found it valuable. Your healing journey continues — please follow the protocol shared during the session.

For any follow-up questions, you can book your next consultation on our website.

_theanirudhcode — Heal the Real You_`;
  return sendText(phone, msg);
}

// 6. Consultation request confirmation to patient
async function sendConsultationAck(phone, name) {
  const msg =
`◆ *theanirudhcode*

Hello ${name.split(' ')[0]},

✅ We've received your *consultation request*!

Dr. Anirudh's team will review your details and reach out within *24 hours* to schedule your session.

In the meantime, feel free to explore the insights on our website.

_theanirudhcode — Heal the Real You_`;
  return sendText(phone, msg);
}

// 7. Admin notification — new consultation request
async function sendAdminConsultationAlert(consultation) {
  if (!process.env.WA_ADMIN_PHONE) return false;
  const msg =
`◆ *New Consultation Request*

👤 Name: *${consultation.name}*
📧 Email: ${consultation.email}
📱 Phone: ${consultation.phone || 'Not provided'}
📅 Preferred Date: ${consultation.preferred_date || 'Flexible'}

💬 Message: ${consultation.message || 'No message'}

View in dashboard: https://theanirudhcode.com/portal-management`;
  return sendText(process.env.WA_ADMIN_PHONE, msg);
}

// 8. Appointment reminder — 24h before (patient)
async function sendAppointmentReminder(phone, name, appointment) {
  const msg =
`◆ *theanirudhcode — Reminder*

Hello ${name.split(' ')[0]},

This is a friendly reminder that your consultation with Dr. Anirudh is *tomorrow*:

📅 Date: *${appointment.date}*
🕐 Time: *${appointment.time_start} – ${appointment.time_end}* (IST)

Please be available 5 minutes before your scheduled time.

To cancel or reschedule, reply to this message or visit our website.

_theanirudhcode — Heal the Real You_`;
  return sendText(phone, msg);
}

// 9. Appointment reminder — 24h before (admin)
async function sendAdminAppointmentReminder24h(appointment, patient) {
  if (!process.env.WA_ADMIN_PHONE) return false;
  const msg =
`◆ *Appointment Tomorrow — Reminder*

📅 Date: *${appointment.date}*
🕐 Time: *${appointment.time_start} – ${appointment.time_end}* (IST)

👤 Patient: *${patient.name}*
📧 Email: ${patient.email}
📱 Phone: ${patient.phone || 'Not provided'}

🩺 Concerns: ${appointment.health_concerns || 'Not specified'}
🎯 Goals: ${appointment.goals || 'Not specified'}`;
  return sendText(process.env.WA_ADMIN_PHONE, msg);
}

// 10. Appointment reminder — 1h before (patient)
async function sendAppointmentReminder1h(phone, name, appointment) {
  const msg =
`◆ *theanirudhcode — Starting Soon*

Hello ${name.split(' ')[0]},

Your consultation with Dr. Anirudh starts in *1 hour*:

📅 Date: *${appointment.date}*
🕐 Time: *${appointment.time_start} – ${appointment.time_end}* (IST)

Please be ready 5 minutes early.

_theanirudhcode — Heal the Real You_`;
  return sendText(phone, msg);
}

// 11. Appointment reminder — 1h before (admin)
async function sendAdminAppointmentReminder1h(appointment, patient) {
  if (!process.env.WA_ADMIN_PHONE) return false;
  const msg =
`◆ *Appointment in 1 Hour*

📅 Date: *${appointment.date}*
🕐 Time: *${appointment.time_start} – ${appointment.time_end}* (IST)

👤 Patient: *${patient.name}*
📧 Email: ${patient.email}
📱 Phone: ${patient.phone || 'Not provided'}`;
  return sendText(process.env.WA_ADMIN_PHONE, msg);
}

module.exports = {
  isConfigured,
  sendOtpWhatsApp,
  sendBookingConfirmation,
  sendAdminNewBooking,
  sendCancellationNotice,
  sendCompletionMessage,
  sendConsultationAck,
  sendAdminConsultationAlert,
  sendAppointmentReminder,
  sendAdminAppointmentReminder24h,
  sendAppointmentReminder1h,
  sendAdminAppointmentReminder1h,
};
