const express = require('express');
const router = express.Router();
const path = require('path');
const db = require('../database/connection');
const { hybridAdminAuth } = require('../middleware/auth');
const { getSettings } = require('./calendar');

// Serve admin page
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'views', 'admin.html'));
});

// Dashboard stats
router.get('/api/stats', hybridAdminAuth, (req, res) => {
  const totalSubs = db.prepare('SELECT COUNT(*) as c FROM subscribers').get().c;
  const totalConsultations = db.prepare('SELECT COUNT(*) as c FROM consultations').get().c;
  const newConsultations = db.prepare("SELECT COUNT(*) as c FROM consultations WHERE status = 'new'").get().c;
  const todaySubs = db.prepare("SELECT COUNT(*) as c FROM subscribers WHERE date(subscribed_at) = date('now')").get().c;
  const upcomingAppointments = db.prepare("SELECT COUNT(*) as c FROM appointments WHERE date >= date('now') AND status = 'confirmed'").get().c;
  const totalPatients = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'patient'").get().c;
  res.json({ totalSubs, totalConsultations, newConsultations, todaySubs, upcomingAppointments, totalPatients });
});

// Subscribers
router.get('/api/subscribers', hybridAdminAuth, (req, res) => {
  const subscribers = db.prepare('SELECT * FROM subscribers ORDER BY subscribed_at DESC').all();
  res.json({ subscribers, total: subscribers.length });
});

router.delete('/api/subscribers/:id', hybridAdminAuth, (req, res) => {
  db.prepare('DELETE FROM subscribers WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Consultations
router.get('/api/consultations', hybridAdminAuth, (req, res) => {
  const { status } = req.query;
  let consultations;
  if (status) {
    consultations = db.prepare('SELECT * FROM consultations WHERE status = ? ORDER BY created_at DESC').all(status);
  } else {
    consultations = db.prepare('SELECT * FROM consultations ORDER BY created_at DESC').all();
  }
  const counts = db.prepare('SELECT status, COUNT(*) as count FROM consultations GROUP BY status').all();
  res.json({ consultations, statusCounts: counts });
});

router.patch('/api/consultations/:id', hybridAdminAuth, (req, res) => {
  const { status } = req.body;
  const valid = ['new', 'read', 'contacted', 'completed'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  db.prepare("UPDATE consultations SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, req.params.id);
  res.json({ success: true });
});

// Settings
router.get('/api/settings', hybridAdminAuth, (req, res) => {
  const settings = getSettings();
  res.json({ settings });
});

router.put('/api/settings', hybridAdminAuth, (req, res) => {
  const { working_hours_start, working_hours_end, slot_duration, working_days, booking_lead_hours } = req.body;

  const updates = {
    working_hours_start,
    working_hours_end,
    slot_duration: String(slot_duration),
    working_days,
    booking_lead_hours: String(booking_lead_hours)
  };

  const stmt = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) stmt.run(value, key);
  }
  res.json({ success: true });
});

// Users list
router.get('/api/users', hybridAdminAuth, (req, res) => {
  const users = db.prepare("SELECT id, name, email, phone, role, created_at, is_active FROM users ORDER BY created_at DESC").all();
  res.json({ users });
});

module.exports = router;
