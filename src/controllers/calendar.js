const express = require('express');
const router  = express.Router();
const { google } = require('googleapis');
const crypto  = require('crypto');
const prisma  = require('../lib/prisma');
const { authenticate, requireAdmin, hybridAdminAuth } = require('../middleware/auth');

// In-memory OAuth state store: state → expiry timestamp (10-min window)
const oauthStates = new Map();
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function generateOAuthState() {
  const state = crypto.randomBytes(32).toString('hex');
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  // Prune expired entries
  for (const [k, exp] of oauthStates) {
    if (Date.now() > exp) oauthStates.delete(k);
  }
  return state;
}

function consumeOAuthState(state) {
  const exp = oauthStates.get(state);
  if (!exp || Date.now() > exp) return false;
  oauthStates.delete(state);
  return true;
}

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
  const state = generateOAuthState();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state,
  });
  res.json({ url });
});

// GET /api/calendar/oauth/callback — no auth (Google redirects here)
router.get('/oauth/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.redirect('/portal-management?calendar_error=No authorization code received');
  if (!state || !consumeOAuthState(state)) {
    return res.redirect('/portal-management?calendar_error=Invalid or expired OAuth state. Please try again.');
  }

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

  // Admin-manually-blocked slots
  const blockedSlots = await prisma.blockedSlot.findMany({
    where:  { date },
    select: { timeStart: true }
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

    if (blockedSlots.some(b => b.timeStart === slot.start)) return { ...slot, available: false };

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

  const monthBlockedSlots = await prisma.blockedSlot.findMany({
    where:  { date: { startsWith: month } },
    select: { date: true, timeStart: true }
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
    const dayBlocked = monthBlockedSlots.filter(b => b.date === dateStr).map(b => b.timeStart);
    const hasAvailable = allSlots.some(slot => {
      const slotStart = new Date(`${dateStr}T${slot.start}:00${TZ_OFFSET}`);
      const slotEnd   = new Date(`${dateStr}T${slot.end}:00${TZ_OFFSET}`);

      if (slotStart < minTime) return false;
      if (dayBlocked.includes(slot.start)) return false;

      const gcalBusy = busyPeriods.some(b => slotStart < new Date(b.end) && slotEnd > new Date(b.start));
      if (gcalBusy) return false;

      return !dayAppts.some(a => slot.start < a.timeEnd && slot.end > a.timeStart);
    });

    days.push({ date: dateStr, hasSlots: hasAvailable });
  }

  res.json({ month, days });
});

// ── Admin slot management ─────────────────────────────────────────────────────

// GET /api/calendar/admin/slots?date=YYYY-MM-DD
router.get('/admin/slots', hybridAdminAuth, async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Valid date (YYYY-MM-DD) required' });
  }

  const settings = await getSettings();
  const allSlots  = generateSlots(settings);

  const [bookedAppts, blockedSlots] = await Promise.all([
    prisma.appointment.findMany({
      where:  { date, status: 'confirmed' },
      select: { timeStart: true, user: { select: { name: true } } }
    }),
    prisma.blockedSlot.findMany({
      where:  { date },
      select: { timeStart: true, timeEnd: true, reason: true }
    })
  ]);

  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  let gcalBusyPeriods = [];
  let gcalConnected   = false;

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
      gcalBusyPeriods = freeBusy.data.calendars[tokens.calendarId]?.busy || [];
      gcalConnected   = true;
    } catch (err) { console.error('Admin slots GCal error:', err.message); }
  }

  const slots = allSlots.map(slot => {
    const slotStart = new Date(`${date}T${slot.start}:00${TZ_OFFSET}`);
    const slotEnd   = new Date(`${date}T${slot.end}:00${TZ_OFFSET}`);

    const booked = bookedAppts.find(a => a.timeStart === slot.start);
    if (booked) return { ...slot, status: 'booked', patient: booked.user?.name || 'Patient' };

    const blocked = blockedSlots.find(b => b.timeStart === slot.start);
    if (blocked) return { ...slot, status: 'blocked', reason: blocked.reason || null };

    const gcalBusy = gcalBusyPeriods.some(b => slotStart < new Date(b.end) && slotEnd > new Date(b.start));
    if (gcalBusy) return { ...slot, status: 'gcal-busy' };

    return { ...slot, status: 'available' };
  });

  res.json({ date, slots, gcalConnected });
});

// POST /api/calendar/admin/block
router.post('/admin/block', hybridAdminAuth, async (req, res) => {
  const { date, timeStart, timeEnd, reason } = req.body;
  if (!date || !timeStart || !timeEnd) {
    return res.status(400).json({ error: 'date, timeStart, timeEnd required' });
  }

  const existing = await prisma.appointment.findFirst({
    where: { date, timeStart, status: 'confirmed' }
  });
  if (existing) return res.status(409).json({ error: 'Slot already booked by a patient' });

  let gcalEventId = null;
  if (gcalConfigured()) {
    const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
    if (tokens?.refreshToken && tokens?.calendarId) {
      try {
        const client   = getOAuth2Client(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });
        const event    = await calendar.events.insert({
          calendarId:  tokens.calendarId,
          requestBody: {
            summary:      '🚫 Unavailable',
            start:        { dateTime: `${date}T${timeStart}:00`, timeZone: TZ_NAME },
            end:          { dateTime: `${date}T${timeEnd}:00`,   timeZone: TZ_NAME },
            transparency: 'opaque'
          }
        });
        gcalEventId = event.data.id;
      } catch (err) { console.error('GCal block event error:', err.message); }
    }
  }

  await prisma.blockedSlot.upsert({
    where:  { date_timeStart: { date, timeStart } },
    update: { timeEnd, reason: reason || null, gcalEventId },
    create: { date, timeStart, timeEnd, reason: reason || null, gcalEventId }
  });

  res.json({ success: true });
});

// DELETE /api/calendar/admin/unblock
router.delete('/admin/unblock', hybridAdminAuth, async (req, res) => {
  const { date, timeStart } = req.body;
  if (!date || !timeStart) return res.status(400).json({ error: 'date and timeStart required' });

  const blocked = await prisma.blockedSlot.findUnique({
    where: { date_timeStart: { date, timeStart } }
  });
  if (!blocked) return res.status(404).json({ error: 'Slot is not blocked' });

  if (blocked.gcalEventId && gcalConfigured()) {
    const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
    if (tokens?.refreshToken && tokens?.calendarId) {
      try {
        const client   = getOAuth2Client(tokens);
        const calendar = google.calendar({ version: 'v3', auth: client });
        await calendar.events.delete({ calendarId: tokens.calendarId, eventId: blocked.gcalEventId });
      } catch (err) { console.error('GCal unblock event error:', err.message); }
    }
  }

  await prisma.blockedSlot.delete({
    where: { date_timeStart: { date, timeStart } }
  });

  res.json({ success: true });
});

// ── Helpers exported to appointments controller ────────────────────────────────

const CONSULTATION_LABELS = {
  discovery:     '30-min Discovery Call',
  deepdive:      '60-min Deep Dive',
  comprehensive: '90-min Comprehensive',
};

// GCal colorId: 2=sage(green), 4=flamingo(pink/cancelled), 8=graphite(completed), 9=blueberry
const STATUS_COLOR = { confirmed: '2', cancelled: '4', completed: '8', rescheduled: '9' };

function buildEventDescription(appointment, user) {
  const typeLabel = CONSULTATION_LABELS[appointment.consultation_type] || appointment.consultation_type || 'Consultation';
  const price     = appointment.consultation_price
    ? `₹${Number(appointment.consultation_price).toLocaleString('en-IN')}`
    : '—';
  const apptId    = appointment.id ? `#${appointment.id}` : '';

  return [
    '═══ PATIENT ═══',
    `Name    : ${user.name}`,
    `Email   : ${user.email}`,
    `Phone   : ${user.phone || 'Not provided'}`,
    '',
    '═══ APPOINTMENT ═══',
    `ID      : ${apptId}`,
    `Type    : ${typeLabel}`,
    `Fee     : ${price}`,
    `Status  : ${(appointment.status || 'confirmed').toUpperCase()}`,
    '',
    '═══ HEALTH INTAKE ═══',
    `Concerns:\n${appointment.health_concerns || 'Not provided'}`,
    '',
    `Medical History:\n${appointment.medical_history || 'None reported'}`,
    '',
    `Goals:\n${appointment.goals || 'Not specified'}`,
  ].join('\n');
}

async function createCalendarEvent(appointment, user) {
  if (!gcalConfigured()) return null;
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens?.refreshToken || !tokens?.calendarId) return null;

  const typeLabel = CONSULTATION_LABELS[appointment.consultation_type] || 'Consultation';

  try {
    const client   = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    const event    = await calendar.events.insert({
      calendarId: tokens.calendarId,
      requestBody: {
        summary:     `📋 ${typeLabel} — ${user.name}`,
        description: buildEventDescription(appointment, user),
        colorId:     STATUS_COLOR.confirmed,
        start:       { dateTime: `${appointment.date}T${appointment.time_start}:00`, timeZone: TZ_NAME },
        end:         { dateTime: `${appointment.date}T${appointment.time_end}:00`,   timeZone: TZ_NAME },
        attendees:   [{ email: user.email, displayName: user.name }],
        reminders:   { useDefault: false, overrides: [{ method: 'email', minutes: 60 }, { method: 'popup', minutes: 30 }] }
      }
    });
    return event.data.id;
  } catch (err) {
    console.error('Create calendar event error:', err.message);
    return null;
  }
}

// Update event when status changes (cancelled / completed / rescheduled)
async function updateCalendarEvent(eventId, appointment, user, newStatus) {
  if (!gcalConfigured() || !eventId) return;
  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens?.refreshToken || !tokens?.calendarId) return;

  const typeLabel = CONSULTATION_LABELS[appointment.consultation_type] || 'Consultation';
  const statusLabel = newStatus.toUpperCase();
  const statusEmoji = newStatus === 'cancelled' ? '❌' : newStatus === 'completed' ? '✅' : '🔄';
  const updatedAppt = { ...appointment, status: newStatus };

  const patch = {
    summary:     `${statusEmoji} [${statusLabel}] ${typeLabel} — ${user.name}`,
    description: buildEventDescription(updatedAppt, user),
    colorId:     STATUS_COLOR[newStatus] || STATUS_COLOR.confirmed,
  };

  // For reschedule: also update time
  if (newStatus === 'rescheduled' && appointment.new_date) {
    patch.start = { dateTime: `${appointment.new_date}T${appointment.new_time_start}:00`, timeZone: TZ_NAME };
    patch.end   = { dateTime: `${appointment.new_date}T${appointment.new_time_end}:00`,   timeZone: TZ_NAME };
  }

  try {
    const client   = getOAuth2Client(tokens);
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.patch({ calendarId: tokens.calendarId, eventId, requestBody: patch });
  } catch (err) { console.error(`Update calendar event (${newStatus}) error:`, err.message); }
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

router.createCalendarEvent  = createCalendarEvent;
router.updateCalendarEvent  = updateCalendarEvent;
router.deleteCalendarEvent  = deleteCalendarEvent;
router.getSettings          = getSettings;
module.exports = router;
