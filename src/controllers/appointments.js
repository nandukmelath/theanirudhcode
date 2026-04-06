const express = require('express');
const router = express.Router();
const supabase = require('../lib/db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sanitize } = require('../middleware/validate');
const { createCalendarEvent, deleteCalendarEvent } = require('./calendar');
const wa = require('../lib/whatsapp');

function isValidDate(d) {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(new Date(d + 'T00:00:00').getTime());
}

function isValidTime(t) {
  return /^\d{2}:\d{2}$/.test(t);
}

function isValidId(id) {
  return /^\d+$/.test(id);
}

// POST /api/appointments/book (authenticated)
router.post('/book', authenticate, async (req, res) => {
  const { date, time_start, time_end, health_concerns, medical_history, goals } = req.body;

  if (!date || !time_start || !time_end) {
    return res.status(400).json({ error: 'Date and time slot are required' });
  }
  if (!isValidDate(date)) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  if (!isValidTime(time_start) || !isValidTime(time_end)) {
    return res.status(400).json({ error: 'Invalid time format. Use HH:MM.' });
  }
  if (!health_concerns || !health_concerns.trim()) {
    return res.status(400).json({ error: 'Please describe your health concerns' });
  }

  const cleanConcerns = sanitize(health_concerns.trim());
  const cleanHistory = sanitize((medical_history || '').trim());
  const cleanGoals = sanitize((goals || '').trim());

  try {
    // Check for conflict
    const { data: existing } = await supabase
      .from('appointments')
      .select('id')
      .eq('date', date)
      .eq('time_start', time_start)
      .eq('status', 'confirmed')
      .maybeSingle();

    if (existing) {
      return res.status(409).json({ error: 'This time slot has already been booked. Please choose another.' });
    }

    const { data: appointment, error } = await supabase
      .from('appointments')
      .insert({
        user_id: req.user.id,
        date,
        time_start,
        time_end,
        health_concerns: cleanConcerns,
        medical_history: cleanHistory || null,
        goals: cleanGoals || null,
      })
      .select()
      .single();

    if (error) throw error;

    // Create Google Calendar event (non-critical)
    const eventId = await createCalendarEvent(
      { date, time_start, time_end, health_concerns: cleanConcerns, medical_history: cleanHistory, goals: cleanGoals },
      req.user
    );

    if (eventId) {
      await supabase.from('appointments').update({ google_event_id: eventId }).eq('id', appointment.id);
    }

    // WhatsApp notifications (non-blocking)
    const apptData = { date, time_start, time_end, health_concerns: cleanConcerns, goals: cleanGoals, medical_history: cleanHistory };
    wa.sendBookingConfirmation(req.user.phone, req.user.name, apptData).catch(() => {});
    wa.sendAdminNewBooking(apptData, req.user).catch(() => {});

    res.status(201).json({
      success: true,
      message: 'Appointment booked successfully!',
      appointment: { id: appointment.id, date, time_start, time_end, status: 'confirmed' }
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Failed to book appointment. Please try again.' });
  }
});

// GET /api/appointments/my (authenticated)
router.get('/my', authenticate, async (req, res) => {
  try {
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('*')
      .eq('user_id', req.user.id)
      .order('date', { ascending: false })
      .order('time_start', { ascending: true });

    if (error) throw error;

    const today = new Date().toISOString().split('T')[0];
    const upcoming = appointments.filter(a => a.date >= today && a.status === 'confirmed');
    const past = appointments.filter(a => a.date < today || a.status !== 'confirmed');

    res.json({ upcoming, past });
  } catch (err) {
    console.error('My appointments error:', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

// POST /api/appointments/:id/cancel (authenticated)
router.post('/:id/cancel', authenticate, async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid appointment ID' });
  }

  try {
    const { data: appointment } = await supabase
      .from('appointments')
      .select('*')
      .eq('id', parseInt(req.params.id))
      .maybeSingle();

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    if (appointment.status !== 'confirmed') {
      return res.status(400).json({ error: 'Only confirmed appointments can be cancelled' });
    }

    if (req.user.role !== 'admin' && appointment.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only cancel your own appointments' });
    }

    if (req.user.role !== 'admin') {
      const apptTime = new Date(`${appointment.date}T${appointment.time_start}:00+05:30`);
      const hoursUntil = (apptTime.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntil < 24) {
        return res.status(400).json({ error: 'Appointments can only be cancelled at least 24 hours in advance' });
      }
    }

    await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', parseInt(req.params.id));

    if (appointment.google_event_id) {
      await deleteCalendarEvent(appointment.google_event_id);
    }

    // WhatsApp cancellation notice (non-blocking)
    wa.sendCancellationNotice(req.user.phone, req.user.name, appointment).catch(() => {});

    res.json({ success: true, message: 'Appointment cancelled' });
  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel appointment' });
  }
});

// GET /api/appointments/all (admin only)
router.get('/all', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select('*, users(name, email, phone)')
      .order('date', { ascending: false })
      .order('time_start', { ascending: true });

    if (error) throw error;

    const formatted = appointments.map(a => ({
      id: a.id,
      user_id: a.user_id,
      date: a.date,
      time_start: a.time_start,
      time_end: a.time_end,
      status: a.status,
      health_concerns: a.health_concerns,
      medical_history: a.medical_history,
      goals: a.goals,
      google_event_id: a.google_event_id,
      created_at: a.created_at,
      updated_at: a.updated_at,
      patient_name: a.users?.name,
      patient_email: a.users?.email,
      patient_phone: a.users?.phone,
    }));

    res.json({ appointments: formatted });
  } catch (err) {
    console.error('All appointments error:', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

// POST /api/appointments/:id/complete (admin only)
router.post('/:id/complete', authenticate, requireAdmin, async (req, res) => {
  if (!isValidId(req.params.id)) {
    return res.status(400).json({ error: 'Invalid appointment ID' });
  }

  try {
    const { data: appointment } = await supabase
      .from('appointments')
      .select('id, status')
      .eq('id', parseInt(req.params.id))
      .maybeSingle();

    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });
    if (appointment.status !== 'confirmed') {
      return res.status(400).json({ error: 'Only confirmed appointments can be marked complete' });
    }

    await supabase.from('appointments').update({ status: 'completed' }).eq('id', parseInt(req.params.id));

    // WhatsApp thank-you message to patient (non-blocking)
    const { data: patient } = await supabase.from('users').select('name, phone').eq('id', appointment.user_id).maybeSingle();
    if (patient) wa.sendCompletionMessage(patient.phone, patient.name).catch(() => {});

    res.json({ success: true });
  } catch (err) {
    console.error('Complete error:', err);
    res.status(500).json({ error: 'Failed to update appointment' });
  }
});

module.exports = router;
