const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sanitize, checkLen, LIMITS } = require('../middleware/validate');
const { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } = require('./calendar');
const wa = require('../lib/whatsapp');
const mailer = require('../lib/mailer');

function isValidDate(d) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  // Reject impossible calendar dates that JS would silently roll over
  // (e.g. 2026-02-30 → Mar 02). Parse the Y-M-D parts UTC-anchored and require a
  // clean round-trip — a UTC compare avoids the timezone drift a local-parse +
  // toISOString round-trip introduces for dates west of UTC.
  const [y, mo, da] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, da));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === da;
}

function isValidTime(t) {
  // Real clock time only — rejects impossible values like 25:99 that a loose
  // \d{2}:\d{2} regex would accept (and that lexical string compares mis-order).
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

// Normalize Prisma appointment to snake_case for the frontend
function normalize(a) {
  return {
    id:                   a.id,
    user_id:              a.userId,
    date:                 a.date,
    time_start:           a.timeStart,
    time_end:             a.timeEnd,
    status:               a.status,
    consultation_type:    a.consultationType,
    consultation_price:   a.consultationPrice,
    health_concerns:      a.healthConcerns,
    medical_history:      a.medicalHistory,
    goals:                a.goals,
    google_event_id:      a.googleEventId,
    video_room_url:       a.videoRoomUrl || null,
    created_at:           a.createdAt,
    updated_at:           a.updatedAt,
  };
}

const CONSULTATION_TYPES = {
  consultation:  { label: 'Consultation',         price: 2999, duration: 45 },
  // legacy keys retained so historical appointments still render/reschedule correctly
  discovery:     { label: '30-min Discovery',     price: 1500, duration: 30 },
  deepdive:      { label: '60-min Deep Dive',     price: 5000, duration: 60 },
  comprehensive: { label: '90-min Comprehensive', price: 8000, duration: 90 },
};

// POST /api/appointments/book (ADMIN ONLY — staff manual placement)
// The live patient flow is payment-first (Cashfree create-order → verify → bookAfterPayment),
// which records payment, patientAge and consentAt. This legacy endpoint creates a
// status=confirmed / paymentStatus=pending appointment with NO payment, age or consent —
// a full payment + TPG-2020 capture bypass if reachable by any patient. It is therefore
// gated behind requireAdmin so only staff can manually place a booking.
router.post('/book', authenticate, requireAdmin, async (req, res) => {
  const { date, time_start, time_end, health_concerns, medical_history, goals, consultation_type } = req.body;

  if (!date || !time_start || !time_end) {
    return res.status(400).json({ error: 'Date and time slot are required' });
  }
  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  const tzOffset = process.env.PRACTITIONER_TZ_OFFSET || '+05:30';
  if (new Date(`${date}T23:59:59${tzOffset}`) < new Date()) {
    return res.status(400).json({ error: 'Cannot book appointments in the past.' });
  }
  if (!isValidTime(time_start) || !isValidTime(time_end)) {
    return res.status(400).json({ error: 'Invalid time format. Use HH:MM.' });
  }
  if (time_end <= time_start) {
    return res.status(400).json({ error: 'End time must be after start time.' });
  }
  if (!health_concerns || typeof health_concerns !== 'string' || !health_concerns.trim()) {
    return res.status(400).json({ error: 'Please describe your health concerns' });
  }
  const hcCheck = checkLen(health_concerns, 'Health concerns', LIMITS.healthConcerns);
  if (!hcCheck.ok) return res.status(400).json({ error: hcCheck.error });
  if (medical_history != null && medical_history !== '') {
    const mhCheck = checkLen(medical_history, 'Medical history', LIMITS.medicalHistory);
    if (!mhCheck.ok) return res.status(400).json({ error: mhCheck.error });
  }
  if (goals != null && goals !== '') {
    const gCheck = checkLen(goals, 'Goals', LIMITS.goals);
    if (!gCheck.ok) return res.status(400).json({ error: gCheck.error });
  }

  const tierKey   = CONSULTATION_TYPES[consultation_type] ? consultation_type : 'consultation';
  const tier      = CONSULTATION_TYPES[tierKey];
  const cleanConcerns = sanitize(health_concerns.trim());
  const cleanHistory  = sanitize((medical_history || '').trim());
  const cleanGoals    = sanitize((goals || '').trim());

  let appointment;
  try {
    // Serializable transaction: conflict check + insert are atomic.
    // The partial unique index (idx_appt_confirmed_slot) is the last line of defence
    // at the DB level; P2002 (unique violation) and P2034 (serialization failure)
    // are both surfaced as a 409 to the client.
    appointment = await prisma.$transaction(async (tx) => {
      // Range-overlap conflict — catches partial overlaps, not just identical start times
      // (a crafted off-grid time_start could otherwise slip past an exact-match check).
      const existing = await tx.appointment.findFirst({
        where: { date, status: 'confirmed', timeStart: { lt: time_end }, timeEnd: { gt: time_start } }
      });
      if (existing) {
        const e = new Error('SLOT_TAKEN');
        e.code  = 'SLOT_TAKEN';
        throw e;
      }
      // Reject bookings that overlap a slot the practitioner has blocked off.
      const blocked = await tx.blockedSlot.findFirst({
        where: { date, timeStart: { lt: time_end }, timeEnd: { gt: time_start } }
      });
      if (blocked) {
        const e = new Error('SLOT_TAKEN');
        e.code  = 'SLOT_TAKEN';
        throw e;
      }
      return tx.appointment.create({
        data: {
          userId:            req.user.id,
          date,
          timeStart:         time_start,
          timeEnd:           time_end,
          consultationType:  tierKey,
          consultationPrice: tier.price,
          healthConcerns:    cleanConcerns,
          medicalHistory:    cleanHistory || null,
          goals:             cleanGoals  || null,
        }
      });
    }, { isolationLevel: 'Serializable' });
  } catch (err) {
    if (err.code === 'SLOT_TAKEN' || err.code === 'P2002' || err.code === 'P2034') {
      return res.status(409).json({ error: 'This time slot has already been booked. Please choose another.' });
    }
    console.error('Booking error:', err);
    return res.status(500).json({ error: 'Failed to book appointment. Please try again.' });
  }

  // Google Calendar (non-critical — swallow errors)
  try {
    const eventId = await createCalendarEvent(
      {
        id:                  appointment.id,
        date,
        time_start,
        time_end,
        consultation_type:  tierKey,
        consultation_price: tier.price,
        health_concerns:    cleanConcerns,
        medical_history:    cleanHistory,
        goals:              cleanGoals,
        status:             'confirmed',
      },
      req.user
    );
    if (eventId) {
      await prisma.appointment.update({
        where: { id: appointment.id },
        data:  { googleEventId: eventId }
      });
    }
  } catch {}

  // WhatsApp notifications (fire-and-forget)
  const apptData = { date, time_start, time_end, health_concerns: cleanConcerns, goals: cleanGoals, medical_history: cleanHistory };
  wa.sendBookingConfirmation(req.user.phone, req.user.name, apptData).catch(e => console.error('[WhatsApp] booking confirmation failed:', e.message));
  wa.sendAdminNewBooking(apptData, req.user).catch(e => console.error('[WhatsApp] admin booking alert failed:', e.message));
  mailer.sendBookingConfirmationEmail(req.user.email, req.user.name, apptData).catch(e => console.error('[Mailer] booking confirmation failed:', e.message));
  mailer.sendAdminBookingEmail(apptData, req.user).catch(e => console.error('[Mailer] admin booking alert failed:', e.message));

  res.status(201).json({
    success: true,
    message: 'Appointment booked successfully!',
    appointment: { id: appointment.id, date, time_start, time_end, status: 'confirmed' }
  });
});

// GET /api/appointments/my (authenticated)
router.get('/my', authenticate, async (req, res) => {
  try {
    const appointments = await prisma.appointment.findMany({
      where:   { userId: req.user.id },
      orderBy: [{ date: 'desc' }, { timeStart: 'asc' }]
    });

    const normalized = appointments.map(normalize);
    // Split by the appointment's END datetime in the practitioner timezone, not by
    // date alone — otherwise a confirmed appointment earlier *today* still shows as
    // "Upcoming" (and offers Cancel) until midnight.
    const tzOffset = process.env.PRACTITIONER_TZ_OFFSET || '+05:30';
    const now      = Date.now();
    const isUpcoming = (a) => {
      if (a.status !== 'confirmed') return false;
      const end = new Date(`${a.date}T${a.time_end || '23:59'}:00${tzOffset}`).getTime();
      return Number.isFinite(end) ? end >= now : true;
    };
    const upcoming = normalized.filter(isUpcoming);
    const past     = normalized.filter(a => !isUpcoming(a));

    res.json({ upcoming, past });
  } catch (err) {
    console.error('My appointments error:', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

// POST /api/appointments/:id/cancel (authenticated)
router.post('/:id/cancel', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid appointment ID' });

  try {
    const appointment = await prisma.appointment.findUnique({ where: { id } });

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    if (appointment.status !== 'confirmed') {
      return res.status(400).json({ error: 'Only confirmed appointments can be cancelled' });
    }

    if (req.user.role !== 'admin' && appointment.userId !== req.user.id) {
      return res.status(403).json({ error: 'You can only cancel your own appointments' });
    }

    if (req.user.role !== 'admin') {
      const tzOffset  = process.env.PRACTITIONER_TZ_OFFSET || '+05:30';
      const apptEnd   = new Date(`${appointment.date}T${appointment.timeEnd}:00${tzOffset}`);
      const apptTime  = new Date(`${appointment.date}T${appointment.timeStart}:00${tzOffset}`);
      // Explicit past-appointment branch — otherwise a past appointment falls into
      // the 24h check and returns the confusing "cancel 24h in advance" message.
      if (apptEnd.getTime() < Date.now()) {
        return res.status(400).json({ error: 'This appointment has already taken place and cannot be cancelled.' });
      }
      const hoursUntil = (apptTime.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntil < 24) {
        return res.status(400).json({ error: 'Appointments can only be cancelled at least 24 hours in advance' });
      }
    }

    await prisma.appointment.update({ where: { id }, data: { status: 'cancelled' } });

    // Update GCal event to show CANCELLED (keep record, don't delete)
    if (appointment.googleEventId) {
      updateCalendarEvent(
        appointment.googleEventId,
        {
          id:                 appointment.id,
          date:               appointment.date,
          time_start:         appointment.timeStart,
          time_end:           appointment.timeEnd,
          consultation_type:  appointment.consultationType,
          consultation_price: appointment.consultationPrice,
          health_concerns:    appointment.healthConcerns,
          medical_history:    appointment.medicalHistory,
          goals:              appointment.goals,
        },
        req.user,
        'cancelled'
      ).catch(e => console.error('[Calendar] cancel event update failed:', e.message));
    }

    wa.sendCancellationNotice(req.user.phone, req.user.name, normalize(appointment)).catch(e => console.error('[WhatsApp] cancellation notice failed:', e.message));

    res.json({ success: true, message: 'Appointment cancelled' });
  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel appointment' });
  }
});

// GET /api/appointments/all (admin only)
router.get('/all', authenticate, requireAdmin, async (req, res) => {
  try {
    const appointments = await prisma.appointment.findMany({
      include:  { user: { select: { name: true, email: true, phone: true } } },
      orderBy: [{ date: 'desc' }, { timeStart: 'asc' }]
    });

    const formatted = appointments.map(a => ({
      ...normalize(a),
      patient_name:  a.user?.name,
      patient_email: a.user?.email,
      patient_phone: a.user?.phone,
    }));

    res.json({ appointments: formatted });
  } catch (err) {
    console.error('All appointments error:', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

// POST /api/appointments/:id/reschedule (authenticated patient)
router.post('/:id/reschedule', authenticate, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid appointment ID' });

  const { date, time_start, time_end } = req.body;
  if (!date || !time_start || !time_end) return res.status(400).json({ error: 'New date and time slot are required' });
  if (!isValidDate(date)) return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  if (!isValidTime(time_start) || !isValidTime(time_end)) return res.status(400).json({ error: 'Invalid time format. Use HH:MM.' });
  if (time_end <= time_start) return res.status(400).json({ error: 'End time must be after start time.' });
  const tzOffset = process.env.PRACTITIONER_TZ_OFFSET || '+05:30';
  if (new Date(`${date}T23:59:59${tzOffset}`) < new Date()) {
    return res.status(400).json({ error: 'Cannot reschedule to a date in the past.' });
  }

  try {
    const appointment = await prisma.appointment.findUnique({ where: { id } });
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    if (appointment.status !== 'confirmed') return res.status(400).json({ error: 'Only confirmed appointments can be rescheduled' });
    if (appointment.userId !== req.user.id) return res.status(403).json({ error: 'You can only reschedule your own appointments' });

    const currentApptTime = new Date(`${appointment.date}T${appointment.timeStart}:00${tzOffset}`);
    if ((currentApptTime.getTime() - Date.now()) < 24 * 60 * 60 * 1000) {
      return res.status(400).json({ error: 'Appointments can only be rescheduled at least 24 hours in advance' });
    }

    if (date === appointment.date && time_start === appointment.timeStart) {
      return res.status(400).json({ error: 'New slot is the same as your current appointment' });
    }

    await prisma.$transaction(async (tx) => {
      const conflict = await tx.appointment.findFirst({
        where: { date, status: 'confirmed', NOT: { id }, timeStart: { lt: time_end }, timeEnd: { gt: time_start } }
      });
      if (conflict) { const e = new Error('SLOT_TAKEN'); e.code = 'SLOT_TAKEN'; throw e; }
      const blocked = await tx.blockedSlot.findFirst({
        where: { date, timeStart: { lt: time_end }, timeEnd: { gt: time_start } }
      });
      if (blocked) { const e = new Error('SLOT_TAKEN'); e.code = 'SLOT_TAKEN'; throw e; }
      await tx.appointment.update({ where: { id }, data: { date, timeStart: time_start, timeEnd: time_end } });
    }, { isolationLevel: 'Serializable' });

    if (appointment.googleEventId) {
      // Delete old slot event, create fresh one with updated time + full details
      deleteCalendarEvent(appointment.googleEventId).catch(e => console.error('[Calendar] delete old event failed:', e.message));
      try {
        const newEventId = await createCalendarEvent(
          {
            id:                 appointment.id,
            date,
            time_start,
            time_end,
            consultation_type:  appointment.consultationType,
            consultation_price: appointment.consultationPrice,
            health_concerns:    appointment.healthConcerns,
            medical_history:    appointment.medicalHistory,
            goals:              appointment.goals,
            status:             'confirmed',
          },
          req.user
        );
        // Always update: set new event ID or clear stale old one
        await prisma.appointment.update({ where: { id }, data: { googleEventId: newEventId || null } });
      } catch (e) {
        console.error('[Calendar] create event failed:', e.message);
        // Clear stale ID so a deleted event isn't referenced again
        await prisma.appointment.update({ where: { id }, data: { googleEventId: null } }).catch(() => {});
      }
    }

    res.json({ success: true, message: 'Appointment rescheduled successfully!', appointment: { id, date, time_start, time_end, status: 'confirmed' } });
  } catch (err) {
    if (err.code === 'SLOT_TAKEN' || err.code === 'P2002' || err.code === 'P2034') {
      return res.status(409).json({ error: 'This time slot is already booked. Please choose another.' });
    }
    console.error('Reschedule error:', err);
    res.status(500).json({ error: 'Failed to reschedule appointment. Please try again.' });
  }
});

// POST /api/appointments/:id/complete (admin only)
router.post('/:id/complete', authenticate, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid appointment ID' });

  try {
    const appointment = await prisma.appointment.findUnique({
      where:   { id },
      include: { user: { select: { name: true, email: true, phone: true } } }
    });

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    if (appointment.status !== 'confirmed') {
      return res.status(400).json({ error: 'Only confirmed appointments can be marked complete' });
    }

    await prisma.appointment.update({ where: { id }, data: { status: 'completed' } });

    // Update GCal event to show COMPLETED
    if (appointment.googleEventId && appointment.user) {
      updateCalendarEvent(
        appointment.googleEventId,
        {
          id:                 appointment.id,
          date:               appointment.date,
          time_start:         appointment.timeStart,
          time_end:           appointment.timeEnd,
          consultation_type:  appointment.consultationType,
          consultation_price: appointment.consultationPrice,
          health_concerns:    appointment.healthConcerns,
          medical_history:    appointment.medicalHistory,
          goals:              appointment.goals,
        },
        appointment.user,
        'completed'
      ).catch(e => console.error('[Calendar] complete event update failed:', e.message));
    }

    if (appointment.user) {
      wa.sendCompletionMessage(appointment.user.phone, appointment.user.name).catch(e => console.error('[WhatsApp] completion message failed:', e.message));
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Complete error:', err);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});

module.exports = router;
