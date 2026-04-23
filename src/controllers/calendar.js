const express = require('express');
const router  = express.Router();
const { google } = require('googleapis');
const prisma  = require('../lib/prisma');
const { authenticate, requireAdmin, hybridAdminAuth } = require('../middleware/auth');

// Practitioner timezone — change via env, no code release needed
const TZ_OFFSET = process.env.PRACTITIONER_TZ_OFFSET || '+05:30';
const TZ_NAME   = process.env.PRACTITIONER_TZ_NAME   || 'Asia/Kolkata';

function gcalConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function getOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  if (tokens && tokens.refreshToken) {
    client.setCredentials({
      access_token:  tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date:   tokens.expiry ? parseInt(tokens.expiry) : undefined
    });

    client.on('tokens', async (newTokens) => {
      try {
        await prisma.googleToken.update({
          where: { id: 1 },
          data: { accessToken: newTokens.access_token, expiry: newTokens.expiry_date ? String(newTokens.expiry_date) : null }
        });
      } catch (err) { console.error('Token refresh save error:', err); }
    });
  }

  return client;
}

async function getSettings() {
  const rows = await prisma.setting.findMany();
  const settings = {};
  rows.forEach(r => { settings[r.key] = r.value; });
  return settings;
}

function generateSlots(settings) {
  const start    = settings.working_hours_start || '09:00';
  const end      = settings.working_hours_end   || '18:00';
  const duration = parseInt(settings.slot_duration || '60');

  const [startH, startM] = start.split(':').map(Number);
  const [endH,   endM]   = end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes   = endH   * 60 + endM;

  const slots = [];
  for (let m = startMinutes; m + duration <= endMinutes; m += duration) {
    const sh = String(Math.floor(m / 60)).padStart(2, '0');
    const sm = String(m % 60).padStart(2, '0');
    const eh = String(Math.floor((m + duration) / 60)).padStart(2, '0');
    const em = String((m + duration) % 60).padStart(2, '0');
    slots.push({ start: `${sh}:${sm}`, end: `${eh}:${em}` });
  }
  return slots;
}

// ── Admin routes (hybridAdminAuth accepts JWT cookie OR x-admin-token header) ──

// GET /api/calendar/auth-url
router.get('/auth-url', hybridAdminAuth, async (req, res) => {
  if (!gcalConfigured()) {
    return res.status(400).json({ error: 'Google Calendar credentials not configured. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI to your environment.' });
  }
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  const client = getOAuth2Client(tokens);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar']
  });
  res.json({ url });
});

// GET /api/calendar/oauth/callback — no auth (Google redirects here)
router.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/portal-management?calendar_error=No authorization code received');

  try {
    const existingTokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
    const client = getOAuth2Client(existingTokens);
    const { tokens } = await client.getToken(code);

    await prisma.googleToken.upsert({
      where:  { id: 1 },
      update: { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiry: tokens.expiry_date ? String(tokens.expiry_date) : null },
      create: { id: 1, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiry: tokens.expiry_date ? String(tokens.expiry_date) : null }
    });

    res.redirect('/portal-management?calendar_success=Google Calendar connected successfully');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/portal-management?calendar_error=Failed to connect Google Calendar');
  }
});

// GET /api/calendar/status
router.get('/status', hybridAdminAuth, async (req, res) => {
  if (!gcalConfigured()) {
    return res.json({ configured: false, connected: false });
  }

  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens || !tokens.refreshToken) {
    return res.json({ configured: true, connected: false });
  }

  try {
    const client   = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.calendarList.list({ maxResults: 1 });
    res.json({ configured: true, connected: true, calendarId: tokens.calendarId || null });
  } catch {
    res.json({ configured: true, connected: false, error: 'Token expired or revoked' });
  }
});

// GET /api/calendar/calendars
router.get('/calendars', hybridAdminAuth, async (req, res) => {
  if (!gcalConfigured()) return res.status(400).json({ error: 'Google Calendar not configured' });
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens || !tokens.refreshToken) return res.status(400).json({ error: 'Google Calendar not connected' });

  try {
    const client   = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const list     = await calendar.calendarList.list();
    res.json({ calendars: list.data.items.map(c => ({ id: c.id, summary: c.summary, primary: c.primary || false })) });
  } catch (err) {
    console.error('List calendars error:', err);
    res.status(500).json({ error: 'Failed to list calendars' });
  }
});

// POST /api/calendar/set-calendar
router.post('/set-calendar', hybridAdminAuth, async (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'Calendar ID is required' });
  await prisma.googleToken.update({ where: { id: 1 }, data: { calendarId } });
  res.json({ success: true });
});

// ── User-facing routes ─────────────────────────────────────────────────────────

// GET /api/calendar/available-slots
router.get('/available-slots', authenticate, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) is required' });
  }

  const settings    = await getSettings();
  const workingDays = (settings.working_days || '1,2,3,4,5').split(',').map(Number);
  const leadHours   = parseInt(settings.booking_lead_hours || '24');

  const dateObj  = new Date(`${date}T00:00:00${TZ_OFFSET}`);
  const dayOfWeek = dateObj.getDay();
  if (!workingDays.includes(dayOfWeek)) return res.json({ date, slots: [] });

  const minTime  = new Date(Date.now() + leadHours * 60 * 60 * 1000);
  const allSlots = generateSlots(settings);

  // Google Calendar freebusy (optional — skipped if not configured/connected)
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  let busyPeriods = [];

  if (gcalConfigured() && tokens?.refreshToken && tokens?.calendarId) {
    try {
      const client   = getOAuth2Client(tokens);
      const calendar = google.calendar({ version: 'v3', auth: client });
      const freeBusy = await calendar.freebusy.query({
        requestBody: {
          timeMin:  `${date}T00:00:00${TZ_OFFSET}`,
          timeMax:  `${date}T23:59:59${TZ_OFFSET}`,
          timeZone: TZ_NAME,
          items:    [{ id: tokens.calendarId }]
        }
      });
      busyPeriods = freeBusy.data.calendars[tokens.calendarId]?.busy || [];
    } catch (err) { console.error('FreeBusy error:', err.message); }
  }

  // DB booked slots
  const dbAppointments = await prisma.appointment.findMany({
    where:  { date, status: 'confirmed' },
    select: { timeStart: true, timeEnd: true }
  });

  const slots = allSlots.map(slot => {
    const slotStart = new Date(`${date}T${slot.start}:00${TZ_OFFSET}`);
    const slotEnd   = new Date(`${date}T${slot.end}:00${TZ_OFFSET}`);

    if (slotStart < minTime) return { ...slot, available: false };

    const gcalBusy = busyPeriods.some(b => {
      return slotStart < new Date(b.end) && slotEnd > new Date(b.start);
    });
    if (gcalBusy) return { ...slot, available: false };

    const dbBusy = dbAppointments.some(a => slot.start < a.timeEnd && slot.end > a.timeStart);
    if (dbBusy) return { ...slot, available: false };

    return { ...slot, available: true };
  });

  res.json({ date, slots });
});

// GET /api/calendar/available-days
router.get('/available-days', authenticate, async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Valid month (YYYY-MM) is required' });
  }

  const settings    = await getSettings();
  const workingDays = (settings.working_days || '1,2,3,4,5').split(',').map(Number);
  const leadHours   = parseInt(settings.booking_lead_hours || '24');

  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const minTime     = new Date(Date.now() + leadHours * 60 * 60 * 1000);

  const dbAppointments = await prisma.appointment.findMany({
    where:  { date: { startsWith: month }, status: 'confirmed' },
    select: { date: true, timeStart: true, timeEnd: true }
  });

  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  let busyPeriods = [];

  if (gcalConfigured() && tokens?.refreshToken && tokens?.calendarId) {
    try {
      const client   = getOAuth2Client(tokens);
      const calendar = google.calendar({ version: 'v3', auth: client });
      const lastDay  = String(daysInMonth).padStart(2, '0');
      const freeBusy = await calendar.freebusy.query({
        requestBody: {
          timeMin:  `${month}-01T00:00:00${TZ_OFFSET}`,
          timeMax:  `${month}-${lastDay}T23:59:59${TZ_OFFSET}`,
          timeZone: TZ_NAME,
          items:    [{ id: tokens.calendarId }]
        }
      });
      busyPeriods = freeBusy.data.calendars[tokens.calendarId]?.busy || [];
    } catch (err) { console.error('Monthly FreeBusy error:', err.message); }
  }

  const allSlots = generateSlots(settings);
  const days = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr  = `${month}-${String(d).padStart(2, '0')}`;
    const dateObj  = new Date(`${dateStr}T00:00:00${TZ_OFFSET}`);
    const dayOfWeek = dateObj.getDay();

    if (!workingDays.includes(dayOfWeek)) { days.push({ date: dateStr, hasSlots: false }); continue; }

    const dayAppts   = dbAppointments.filter(a => a.date === dateStr);
    const hasAvailable = allSlots.some(slot => {
      const slotStart = new Date(`${dateStr}T${slot.start}:00${TZ_OFFSET}`);
      const slotEnd   = new Date(`${dateStr}T${slot.end}:00${TZ_OFFSET}`);

      if (slotStart < minTime) return false;

      const gcalBusy = busyPeriods.some(b => slotStart < new Date(b.end) && slotEnd > new Date(b.start));
      if (gcalBusy) return false;

      return !dayAppts.some(a => slot.start < a.timeEnd && slot.end > a.timeStart);
    });

    days.push({ date: dateStr, hasSlots: hasAvailable });
  }

  res.json({ month, days });
});

// ── Helpers exported to appointments controller ────────────────────────────────

async function createCalendarEvent(appointment, user) {
  if (!gcalConfigured()) return null;
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens?.refreshToken || !tokens?.calendarId) return null;

  try {
    const client   = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const event    = await calendar.events.insert({
      calendarId: tokens.calendarId,
      requestBody: {
        summary:     `Consultation — ${user.name}`,
        description: `Patient: ${user.name}\nEmail: ${user.email}\nPhone: ${user.phone || 'Not provided'}\n\n--- Health Details ---\nConcerns: ${appointment.health_concerns || 'None'}\nHistory: ${appointment.medical_history || 'None'}\nGoals: ${appointment.goals || 'None'}`,
        start: { dateTime: `${appointment.date}T${appointment.time_start}:00`, timeZone: TZ_NAME },
        end:   { dateTime: `${appointment.date}T${appointment.time_end}:00`,   timeZone: TZ_NAME },
        attendees: [{ email: user.email }],
        reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }, { method: 'popup', minutes: 30 }] }
      }
    });
    return event.data.id;
  } catch (err) {
    console.error('Create calendar event error:', err.message);
    return null;
  }
}

async function deleteCalendarEvent(eventId) {
  if (!gcalConfigured()) return;
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens?.refreshToken || !tokens?.calendarId || !eventId) return;

  try {
    const client   = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({ calendarId: tokens.calendarId, eventId });
  } catch (err) { console.error('Delete calendar event error:', err.message); }
}

router.createCalendarEvent = createCalendarEvent;
router.deleteCalendarEvent = deleteCalendarEvent;
router.getSettings = getSettings;
module.exports = router;
