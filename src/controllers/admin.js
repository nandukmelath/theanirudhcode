const express = require('express');
const router = express.Router();
const path = require('path');
const prisma = require('../lib/prisma');
const { hybridAdminAuth } = require('../middleware/auth');
const { getSettings } = require('./calendar');

// Serve admin page (protected)
router.get('/', hybridAdminAuth, (req, res) => {
  res.sendFile(path.join(__dirname, '..', '..', 'views', 'admin.html'));
});

// Dashboard stats
router.get('/api/stats', hybridAdminAuth, async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const todayStr = today.toISOString().split('T')[0];

    const [totalSubs, totalConsultations, newConsultations, todaySubs, upcomingAppointments, totalPatients, livesTransformed, activeJourneys] = await Promise.all([
      prisma.subscriber.count(),
      prisma.consultation.count(),
      prisma.consultation.count({ where: { status: 'new' } }),
      prisma.subscriber.count({ where: { subscribedAt: { gte: today, lt: tomorrow } } }),
      prisma.appointment.count({ where: { date: { gte: todayStr }, status: 'confirmed' } }),
      prisma.user.count({ where: { role: 'patient' } }),
      prisma.appointment.count({ where: { status: 'completed' } }),
      prisma.appointment.count({ where: { status: 'confirmed' } }),
    ]);

    res.json({ totalSubs, totalConsultations, newConsultations, todaySubs, upcomingAppointments, totalPatients, livesTransformed, activeJourneys });
  } catch (err) {
    console.error('Stats error:', err);
    res.status(500).json({ error: 'Failed to load stats' });
  }
});

// Subscribers
router.get('/api/subscribers', hybridAdminAuth, async (req, res) => {
  try {
    const subscribers = await prisma.subscriber.findMany({ orderBy: { subscribedAt: 'desc' } });
    res.json({ subscribers, total: subscribers.length });
  } catch (err) {
    console.error('Subscribers error:', err);
    res.status(500).json({ error: 'Failed to load subscribers' });
  }
});

router.delete('/api/subscribers/:id', hybridAdminAuth, async (req, res) => {
  try {
    await prisma.subscriber.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Subscriber not found' });
    console.error('Delete subscriber error:', err);
    res.status(500).json({ error: 'Failed to delete subscriber' });
  }
});

// Consultations
router.get('/api/consultations', hybridAdminAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const where = status ? { status } : {};
    const consultations = await prisma.consultation.findMany({ where, orderBy: { createdAt: 'desc' } });
    const all = await prisma.consultation.findMany({ select: { status: true } });
    const statusCounts = all.reduce((acc, c) => { acc[c.status] = (acc[c.status] || 0) + 1; return acc; }, {});
    res.json({ consultations, statusCounts });
  } catch (err) {
    console.error('Consultations error:', err);
    res.status(500).json({ error: 'Failed to load consultations' });
  }
});

router.patch('/api/consultations/:id', hybridAdminAuth, async (req, res) => {
  const { status } = req.body;
  const valid = ['new', 'read', 'contacted', 'completed'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    await prisma.consultation.update({ where: { id: parseInt(req.params.id) }, data: { status } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Consultation not found' });
    console.error('Update consultation error:', err);
    res.status(500).json({ error: 'Failed to update consultation' });
  }
});

// Settings
router.get('/api/settings', hybridAdminAuth, async (req, res) => {
  try {
    const settings = await getSettings();
    res.json({ settings });
  } catch (err) {
    console.error('Settings error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.put('/api/settings', hybridAdminAuth, async (req, res) => {
  const { working_hours_start, working_hours_end, slot_duration, working_days, booking_lead_hours } = req.body;

  const timeRegex = /^\d{2}:\d{2}$/;
  if (working_hours_start && !timeRegex.test(working_hours_start)) return res.status(400).json({ error: 'Invalid start time format. Use HH:MM.' });
  if (working_hours_end && !timeRegex.test(working_hours_end)) return res.status(400).json({ error: 'Invalid end time format. Use HH:MM.' });

  const validDurations = [15, 30, 45, 60];
  if (slot_duration && !validDurations.includes(Number(slot_duration))) return res.status(400).json({ error: 'Slot duration must be 15, 30, 45, or 60 minutes.' });

  if (working_days) {
    const days = working_days.split(',');
    const allValid = days.every(d => /^[0-6]$/.test(d.trim()));
    if (!allValid) return res.status(400).json({ error: 'Invalid working days. Use 0-6 (Sun-Sat).' });
  }

  if (booking_lead_hours) {
    const hours = Number(booking_lead_hours);
    if (isNaN(hours) || hours < 1 || hours > 168) return res.status(400).json({ error: 'Booking lead time must be 1-168 hours.' });
  }

  try {
    const updates = [];
    if (working_hours_start) updates.push(prisma.setting.upsert({ where: { key: 'working_hours_start' }, update: { value: working_hours_start }, create: { key: 'working_hours_start', value: working_hours_start } }));
    if (working_hours_end) updates.push(prisma.setting.upsert({ where: { key: 'working_hours_end' }, update: { value: working_hours_end }, create: { key: 'working_hours_end', value: working_hours_end } }));
    if (slot_duration) updates.push(prisma.setting.upsert({ where: { key: 'slot_duration' }, update: { value: String(slot_duration) }, create: { key: 'slot_duration', value: String(slot_duration) } }));
    if (working_days) updates.push(prisma.setting.upsert({ where: { key: 'working_days' }, update: { value: working_days }, create: { key: 'working_days', value: working_days } }));
    if (booking_lead_hours) updates.push(prisma.setting.upsert({ where: { key: 'booking_lead_hours' }, update: { value: String(booking_lead_hours) }, create: { key: 'booking_lead_hours', value: String(booking_lead_hours) } }));
    await Promise.all(updates);
    res.json({ success: true });
  } catch (err) {
    console.error('Save settings error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Users list
router.get('/api/users', hybridAdminAuth, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, name: true, email: true, phone: true, role: true, createdAt: true, isActive: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ users });
  } catch (err) {
    console.error('Users error:', err);
    res.status(500).json({ error: 'Failed to load users' });
  }
});

module.exports = router;
