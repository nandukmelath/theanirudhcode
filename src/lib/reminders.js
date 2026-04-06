/**
 * Appointment Reminder Scheduler
 * Runs every hour — sends WhatsApp reminders 24h and 1h before appointments
 */

const supabase = require('./db');
const wa = require('./whatsapp');

async function sendUpcomingReminders() {
  if (!wa.isConfigured()) return;

  try {
    const now = new Date();

    // Window for 24h reminder: appointments 23–25h from now
    const from24 = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const to24   = new Date(now.getTime() + 25 * 60 * 60 * 1000);

    // Window for 1h reminder: appointments 45min–75min from now
    const from1h = new Date(now.getTime() + 45 * 60 * 1000);
    const to1h   = new Date(now.getTime() + 75 * 60 * 1000);

    // Fetch appointments covering both windows
    const earliest = from1h.toISOString().split('T')[0];
    const latest   = to24.toISOString().split('T')[0];

    const { data: appointments } = await supabase
      .from('appointments')
      .select('*, users(name, email, phone)')
      .eq('status', 'confirmed')
      .gte('date', earliest)
      .lte('date', latest);

    if (!appointments || appointments.length === 0) return;

    for (const appt of appointments) {
      const apptTime = new Date(`${appt.date}T${appt.time_start}:00+05:30`);
      const hoursAway = (apptTime - now) / (1000 * 60 * 60);
      const patient = appt.users;

      if (!patient) continue;

      // 24h reminder
      if (hoursAway >= 23 && hoursAway <= 25) {
        if (patient.phone) {
          await wa.sendAppointmentReminder(patient.phone, patient.name, appt);
          console.log(`[Reminder 24h] Sent to patient ${patient.name} for ${appt.date} ${appt.time_start}`);
        }
        await wa.sendAdminAppointmentReminder24h(appt, patient);
        console.log(`[Reminder 24h] Sent to admin for ${appt.date} ${appt.time_start}`);
      }

      // 1h reminder
      if (hoursAway >= 0.75 && hoursAway <= 1.25) {
        if (patient.phone) {
          await wa.sendAppointmentReminder1h(patient.phone, patient.name, appt);
          console.log(`[Reminder 1h] Sent to patient ${patient.name} for ${appt.date} ${appt.time_start}`);
        }
        await wa.sendAdminAppointmentReminder1h(appt, patient);
        console.log(`[Reminder 1h] Sent to admin for ${appt.date} ${appt.time_start}`);
      }
    }
  } catch (err) {
    console.error('[Reminder] Error:', err.message);
  }
}

function startReminderScheduler() {
  if (!wa.isConfigured()) {
    console.log('[Reminder] WhatsApp not configured — reminders disabled');
    return;
  }
  console.log('[Reminder] Scheduler started — checking every hour for 24h & 1h reminders');
  // Run once on startup, then every hour
  sendUpcomingReminders();
  setInterval(sendUpcomingReminders, 60 * 60 * 1000);
}

module.exports = { startReminderScheduler };
