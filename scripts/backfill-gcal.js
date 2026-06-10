/**
 * One-shot: create Google Calendar events for all confirmed appointments
 * that have no googleEventId. Run with: railway run node scripts/backfill-gcal.js
 */

try { require('dotenv').config(); } catch (_) { /* railway run injects env vars directly */ }
const { google } = require('googleapis');
const prisma     = require('../src/lib/prisma');

const TZ_NAME = process.env.PRACTITIONER_TZ_NAME || 'Asia/Kolkata';

const CONSULTATION_LABELS = {
  discovery:     '30-min Discovery Call',
  deepdive:      '60-min Deep Dive',
  comprehensive: '90-min Comprehensive',
};

function getOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  client.setCredentials({
    access_token:  tokens.accessToken,
    refresh_token: tokens.refreshToken,
    expiry_date:   tokens.expiry ? parseInt(tokens.expiry) : undefined,
  });
  return client;
}

async function main() {
  console.log('=== Google Calendar Backfill ===');

  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    console.error('Missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET'); process.exit(1);
  }

  const tokens = await prisma.googleToken.findUnique({ where: { id: 1 } });
  if (!tokens?.refreshToken) { console.error('No Google refresh token in DB'); process.exit(1); }
  if (!tokens?.calendarId)   { console.error('No calendarId set in DB');        process.exit(1); }

  console.log('Calendar ID:', tokens.calendarId);

  const client   = getOAuth2Client(tokens);
  const calendar = google.calendar({ version: 'v3', auth: client });

  const appointments = await prisma.appointment.findMany({
    where:   { status: 'confirmed', googleEventId: null },
    include: { user: { select: { id: true, name: true, email: true, phone: true } } },
    orderBy: { date: 'asc' },
  });

  console.log(`Found ${appointments.length} appointments without GCal events`);

  let ok = 0, fail = 0;
  for (const appt of appointments) {
    const typeLabel = CONSULTATION_LABELS[appt.consultationType] || 'Consultation';
    const price     = appt.consultationPrice ? `₹${Number(appt.consultationPrice).toLocaleString('en-IN')}` : '—';
    const user      = appt.user;

    const description = [
      '═══ PATIENT ═══',
      `Name    : ${user.name}`,
      `Email   : ${user.email}`,
      `Phone   : ${user.phone || 'Not provided'}`,
      '',
      '═══ APPOINTMENT ═══',
      `ID      : #${appt.id}`,
      `Type    : ${typeLabel}`,
      `Fee     : ${price}`,
      `Status  : CONFIRMED`,
      '',
      '═══ HEALTH INTAKE ═══',
      `Concerns:\n${appt.healthConcerns || 'Not provided'}`,
      '',
      `Medical History:\n${appt.medicalHistory || 'None reported'}`,
      '',
      `Goals:\n${appt.goals || 'Not specified'}`,
    ].join('\n');

    try {
      const event = await calendar.events.insert({
        calendarId: tokens.calendarId,
        requestBody: {
          summary:     `📋 ${typeLabel} — ${user.name}`,
          description,
          colorId:     '2',
          start:       { dateTime: `${appt.date}T${appt.timeStart}:00`, timeZone: TZ_NAME },
          end:         { dateTime: `${appt.date}T${appt.timeEnd}:00`,   timeZone: TZ_NAME },
          attendees:   [{ email: user.email, displayName: user.name }],
          reminders:   { useDefault: false, overrides: [{ method: 'email', minutes: 60 }, { method: 'popup', minutes: 30 }] },
        }
      });

      const eventId = event.data.id;
      await prisma.appointment.update({ where: { id: appt.id }, data: { googleEventId: eventId } });
      console.log(`✓ #${appt.id} ${appt.date} ${appt.timeStart} — ${user.name} → ${eventId}`);
      ok++;
    } catch (err) {
      console.error(`✗ #${appt.id} ${appt.date} ${appt.timeStart} — ${user.name}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone. ${ok} created, ${fail} failed.`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
