const express = require('express');
const router = express.Router();
const db = require('../database/connection');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { sanitize } = require('../middleware/validate');
const { createCalendarEvent, deleteCalendarEvent } = require('./calendar');

// POST /api/appointments/book (authenticated)
router.post('/book', authenticate, async (req, res) => {
  const { date, time_start, time_end, health_concerns, medical_history, goals } = req.body;

  if (!date || !time_start || !time_end) {
    return res.status(400).json({ error: 'Date and time slot are required' });
  }
  if (!health_concerns || !health_concerns.trim()) {
    return res.status(400).json({ error: 'Please describe your health concerns' });
  }

  const cleanConcerns = sanitize(health_concerns.trim());
  const cleanHistory = sanitize((medical_history || '').trim());
  const cleanGoals = sanitize((goals || '').trim());

  try {
    // Double-booking check
    const existing = db.prepare(
      "SELECT id FROM appointments WHERE date = ? AND time_start = ? AND status = 'confirmed'"
    ).get(date, time_start);

    if (existing) {
      return res.status(409).json({ error: 'This time slot has already been booked. Please choose another.' });
    }

    // Insert appointment
    const result = db.prepare(
      'INSERT INTO appointments (user_id, date, time_start, time_end, health_concerns, medical_history, goals) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, date, time_start, time_end, cleanConcerns, cleanHistory, cleanGoals);

    const appointmentId = result.lastInsertRowid;

    // Create Google Calendar event
    const eventId = await createCalendarEvent(
      { date, time_start, time_end, health_concerns: cleanConcerns, medical_history: cleanHistory, goals: cleanGoals },
      req.user
    );

    if (eventId) {
      db.prepare('UPDATE appointments SET google_event_id = ? WHERE id = ?').run(eventId, appointmentId);
    }

    res.status(201).json({
      success: true,
      message: 'Appointment booked successfully!',
      appointment: { id: appointmentId, date, time_start, time_end, status: 'confirmed' }
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ error: 'Failed to book appointment. Please try again.' });
  }
});

// GET /api/appointments/my (authenticated)
router.get('/my', authenticate, (req, res) => {
  try {
    const appointments = db.prepare(
      'SELECT * FROM appointments WHERE user_id = ? ORDER BY date DESC, time_start'
    ).all(req.user.id);

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
  try {
    const appointment = db.prepare('SELECT * FROM appointments WHERE id = ?').get(req.params.id);
    if (!appointment) return res.status(404).json({ error: 'Appointment not found' });

    // Patients can only cancel their own appointments
    if (req.user.role !== 'admin' && appointment.user_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only cancel your own appointments' });
    }

    // Check 24h cancellation window for patients
    if (req.user.role !== 'admin') {
      const apptTime = new Date(`${appointment.date}T${appointment.time_start}:00+05:30`);
      const hoursUntil = (apptTime.getTime() - Date.now()) / (1000 * 60 * 60);
      if (hoursUntil < 24) {
        return res.status(400).json({ error: 'Appointments can only be cancelled at least 24 hours in advance' });
      }
    }

    db.prepare("UPDATE appointments SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?").run(req.params.id);

    if (appointment.google_event_id) {
      await deleteCalendarEvent(appointment.google_event_id);
    }

    res.json({ success: true, message: 'Appointment cancelled' });
  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ error: 'Failed to cancel appointment' });
  }
});

// GET /api/appointments/all (admin only)
router.get('/all', authenticate, requireAdmin, (req, res) => {
  try {
    const appointments = db.prepare(
      'SELECT a.*, u.name as patient_name, u.email as patient_email, u.phone as patient_phone FROM appointments a JOIN users u ON a.user_id = u.id ORDER BY a.date DESC, a.time_start'
    ).all();
    res.json({ appointments });
  } catch (err) {
    console.error('All appointments error:', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

// POST /api/appointments/:id/complete (admin only)
router.post('/:id/complete', authenticate, requireAdmin, (req, res) => {
  db.prepare("UPDATE appointments SET status = 'completed', updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
