const express = require('express');
const router = express.Router();
const { google } = require('googleapis');
const prisma = require('../lib/prisma');
const { authenticate, requireAdmin } = require('../middleware/auth');

function getOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  if (tokens && tokens.refreshToken) {
    client.setCredentials({
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      expiry_date: tokens.expiry ? parseInt(tokens.expiry) : undefined
    });

    client.on('tokens', async (newTokens) => {
      try {
        await prisma.googleToken.update({
          where: { id: 1 },
          data: { accessToken: newTokens.access_token, expiry: newTokens.expiry_date ? String(newTokens.expiry_date) : null }
        });
      } catch (err) {
        console.error('Token refresh save error:', err);
      }
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
  const start = settings.working_hours_start || '09:00';
  const end = settings.working_hours_end || '18:00';
  const duration = parseInt(settings.slot_duration || '60');

  const [startH, startM] = start.split(':').map(Number);
  const [endH, endM] = end.split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

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

// GET /api/calendar/auth-url (admin only)
router.get('/auth-url', authenticate, requireAdmin, async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Google Calendar credentials not configured. Please add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to your .env file.' });
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

// GET /api/calendar/oauth/callback
router.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/portal-management?calendar_error=No authorization code received');

  try {
    const existingTokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
    const client = getOAuth2Client(existingTokens);
    const { tokens } = await client.getToken(code);

    await prisma.googleToken.upsert({
      where: { id: 1 },
      update: {
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiry: tokens.expiry_date ? String(tokens.expiry_date) : null,
      },
      create: {
        id: 1,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        expiry: tokens.expiry_date ? String(tokens.expiry_date) : null,
      }
    });

    res.redirect('/portal-management?calendar_success=Google Calendar connected successfully');
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.redirect('/portal-management?calendar_error=Failed to connect Google Calendar');
  }
});

// GET /api/calendar/status (admin only)
router.get('/status', authenticate, requireAdmin, async (req, res) => {
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });

  if (!tokens || !tokens.refreshToken) {
    return res.json({ connected: false });
  }

  try {
    const client = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.calendarList.list({ maxResults: 1 });
    res.json({ connected: true, calendarId: tokens.calendarId || null });
  } catch (err) {
    res.json({ connected: false, error: 'Token expired or revoked' });
  }
});

// GET /api/calendar/calendars (admin only)
router.get('/calendars', authenticate, requireAdmin, async (req, res) => {
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens || !tokens.refreshToken) {
    return res.status(400).json({ error: 'Google Calendar not connected' });
  }

  try {
    const client = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const list = await calendar.calendarList.list();
    const calendars = list.data.items.map(c => ({ id: c.id, summary: c.summary, primary: c.primary || false }));
    res.json({ calendars });
  } catch (err) {
    console.error('List calendars error:', err);
    res.status(500).json({ error: 'Failed to list calendars' });
  }
});

// POST /api/calendar/set-calendar (admin only)
router.post('/set-calendar', authenticate, requireAdmin, async (req, res) => {
  const { calendarId } = req.body;
  if (!calendarId) return res.status(400).json({ error: 'Calendar ID is required' });

  await prisma.googleToken.update({ where: { id: 1 }, data: { calendarId } });
  res.json({ success: true });
});

// GET /api/calendar/available-slots (authenticated)
router.get('/available-slots', authenticate, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) is required' });
  }

  const settings = await getSettings();
  const workingDays = (settings.working_days || '1,2,3,4,5').split(',').map(Number);
  const leadHours = parseInt(settings.booking_lead_hours || '24');

  const dateObj = new Date(date + 'T00:00:00+05:30');
  const dayOfWeek = dateObj.getDay();
  if (!workingDays.includes(dayOfWeek)) {
    return res.json({ date, slots: [] });
  }

  const now = new Date();
  const minTime = new Date(now.getTime() + leadHours * 60 * 60 * 1000);

  const allSlots = generateSlots(settings);

  // Check Google Calendar
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  let busyPeriods = [];

  if (tokens && tokens.refreshToken && tokens.calendarId) {
    try {
      const client = getOAuth2Client(tokens);
      const calendar = google.calendar({ version: 'v3', auth: client });
      const freeBusy = await calendar.freebusy.query({
        requestBody: {
          timeMin: `${date}T00:00:00+05:30`,
          timeMax: `${date}T23:59:59+05:30`,
          timeZone: 'Asia/Kolkata',
          items: [{ id: tokens.calendarId }]
        }
      });
      busyPeriods = freeBusy.data.calendars[tokens.calendarId]?.busy || [];
    } catch (err) {
      console.error('FreeBusy error:', err.message);
    }
  }

  // Check DB
  const dbAppointments = await prisma.appointment.findMany({
    where: { date, status: 'confirmed' },
    select: { timeStart: true, timeEnd: true }
  });

  const slots = allSlots.map(slot => {
    const slotStart = new Date(`${date}T${slot.start}:00+05:30`);
    const slotEnd = new Date(`${date}T${slot.end}:00+05:30`);

    if (slotStart < minTime) return { ...slot, available: false };

    const gcalBusy = busyPeriods.some(busy => {
      const busyStart = new Date(busy.start);
      const busyEnd = new Date(busy.end);
      return slotStart < busyEnd && slotEnd > busyStart;
    });
    if (gcalBusy) return { ...slot, available: false };

    const dbBusy = dbAppointments.some(appt => {
      return slot.start < appt.timeEnd && slot.end > appt.timeStart;
    });
    if (dbBusy) return { ...slot, available: false };

    return { ...slot, available: true };
  });

  res.json({ date, slots });
});

// GET /api/calendar/available-days (authenticated)
router.get('/available-days', authenticate, async (req, res) => {
  const { month } = req.query;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'Valid month (YYYY-MM) is required' });
  }

  const settings = await getSettings();
  const workingDays = (settings.working_days || '1,2,3,4,5').split(',').map(Number);
  const leadHours = parseInt(settings.booking_lead_hours || '24');

  const [year, mon] = month.split('-').map(Number);
  const daysInMonth = new Date(year, mon, 0).getDate();
  const now = new Date();
  const minTime = new Date(now.getTime() + leadHours * 60 * 60 * 1000);

  const dbAppointments = await prisma.appointment.findMany({
    where: { date: { startsWith: month }, status: 'confirmed' },
    select: { date: true, timeStart: true, timeEnd: true }
  });

  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  let busyPeriods = [];

  if (tokens && tokens.refreshToken && tokens.calendarId) {
    try {
      const client = getOAuth2Client(tokens);
      const calendar = google.calendar({ version: 'v3', auth: client });
      const freeBusy = await calendar.freebusy.query({
        requestBody: {
          timeMin: `${month}-01T00:00:00+05:30`,
          timeMax: `${month}-${String(daysInMonth).padStart(2, '0')}T23:59:59+05:30`,
          timeZone: 'Asia/Kolkata',
          items: [{ id: tokens.calendarId }]
        }
      });
      busyPeriods = freeBusy.data.calendars[tokens.calendarId]?.busy || [];
    } catch (err) {
      console.error('Monthly FreeBusy error:', err.message);
    }
  }

  const allSlots = generateSlots(settings);
  const days = [];

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${month}-${String(d).padStart(2, '0')}`;
    const dateObj = new Date(dateStr + 'T00:00:00+05:30');
    const dayOfWeek = dateObj.getDay();

    if (!workingDays.includes(dayOfWeek)) {
      days.push({ date: dateStr, hasSlots: false });
      continue;
    }

    const dayAppts = dbAppointments.filter(a => a.date === dateStr);
    const hasAvailable = allSlots.some(slot => {
      const slotStart = new Date(`${dateStr}T${slot.start}:00+05:30`);
      const slotEnd = new Date(`${dateStr}T${slot.end}:00+05:30`);

      if (slotStart < minTime) return false;

      const gcalBusy = busyPeriods.some(busy => {
        const busyStart = new Date(busy.start);
        const busyEnd = new Date(busy.end);
        return slotStart < busyEnd && slotEnd > busyStart;
      });
      if (gcalBusy) return false;

      const dbBusy = dayAppts.some(appt => slot.start < appt.timeEnd && slot.end > appt.timeStart);
      if (dbBusy) return false;

      return true;
    });

    days.push({ date: dateStr, hasSlots: hasAvailable });
  }

  res.json({ month, days });
});

// Create a Google Calendar event
async function createCalendarEvent(appointment, user) {
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens || !tokens.refreshToken || !tokens.calendarId) return null;

  try {
    const client = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const event = await calendar.events.insert({
      calendarId: tokens.calendarId,
      requestBody: {
        summary: `Consultation — ${user.name}`,
        description: `Patient: ${user.name}\nEmail: ${user.email}\nPhone: ${user.phone || 'Not provided'}\n\n--- Health Details ---\nConcerns: ${appointment.health_concerns || 'None specified'}\nMedical History: ${appointment.medical_history || 'None specified'}\nGoals: ${appointment.goals || 'None specified'}`,
        start: { dateTime: `${appointment.date}T${appointment.time_start}:00`, timeZone: 'Asia/Kolkata' },
        end: { dateTime: `${appointment.date}T${appointment.time_end}:00`, timeZone: 'Asia/Kolkata' },
        attendees: [{ email: user.email }],
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 60 },
            { method: 'popup', minutes: 30 }
          ]
        }
      }
    });
    return event.data.id;
  } catch (err) {
    console.error('Create calendar event error:', err.message);
    return null;
  }
}

async function deleteCalendarEvent(eventId) {
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens || !tokens.refreshToken || !tokens.calendarId || !eventId) return;

  try {
    const client = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({ calendarId: tokens.calendarId, eventId });
  } catch (err) {
    console.error('Delete calendar event error:', err.message);
  }
}

router.createCalendarEvent = createCalendarEvent;
router.deleteCalendarEvent = deleteCalendarEvent;
router.getSettings = getSettings;
module.exports = router;
