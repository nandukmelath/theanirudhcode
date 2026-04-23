const express = require('express');
const router = express.Router();
const path = require('path');
const prisma = require('../lib/prisma');
const { hybridAdminAuth } = require('../middleware/auth');
const { getSettings } = require('./calendar');
const { sanitize } = require('../middleware/validate');
const { sendConsultationReply } = require('../lib/mailer');

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
    if (working_hours_start) { const v = working_hours_start.trim(); updates.push(prisma.setting.upsert({ where: { key: 'working_hours_start' }, update: { value: v }, create: { key: 'working_hours_start', value: v } })); }
    if (working_hours_end)   { const v = working_hours_end.trim();   updates.push(prisma.setting.upsert({ where: { key: 'working_hours_end'   }, update: { value: v }, create: { key: 'working_hours_end',   value: v } })); }
    if (slot_duration)       { const v = String(Number(slot_duration));  updates.push(prisma.setting.upsert({ where: { key: 'slot_duration'       }, update: { value: v }, create: { key: 'slot_duration',       value: v } })); }
    if (working_days)        { const v = working_days.replace(/[^0-6,]/g, ''); updates.push(prisma.setting.upsert({ where: { key: 'working_days'  }, update: { value: v }, create: { key: 'working_days',        value: v } })); }
    if (booking_lead_hours)  { const v = String(Number(booking_lead_hours)); updates.push(prisma.setting.upsert({ where: { key: 'booking_lead_hours' }, update: { value: v }, create: { key: 'booking_lead_hours', value: v } })); }
    await Promise.all(updates);
    res.json({ success: true });
  } catch (err) {
    console.error('Save settings error:', err);
    res.status(500).json({ error: 'Failed to save settings' });
  }
});

// Consultation reply
router.post('/api/consultations/:id/reply', hybridAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });
  const { reply } = req.body;
  if (!reply || !reply.trim()) return res.status(400).json({ error: 'Reply message is required' });

  try {
    const consultation = await prisma.consultation.update({
      where: { id },
      data: { adminReply: reply.trim(), repliedAt: new Date(), status: 'contacted' }
    });
    sendConsultationReply(consultation.email, consultation.name, reply.trim()).catch(e => console.error('[Mailer] consultation reply failed:', e.message));
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Consultation not found' });
    console.error('Reply consultation error:', err);
    res.status(500).json({ error: 'Failed to send reply' });
  }
});

// Blog CRUD
router.get('/api/posts', hybridAdminAuth, async (req, res) => {
  try {
    const posts = await prisma.post.findMany({
      select: { id: true, title: true, slug: true, category: true, published: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ posts });
  } catch (err) {
    console.error('Posts list error:', err);
    res.status(500).json({ error: 'Failed to load posts' });
  }
});

router.post('/api/posts', hybridAdminAuth, async (req, res) => {
  const { title, slug, category, tags, excerpt, content, canvasType, published } = req.body;
  if (!title?.trim() || !excerpt?.trim() || !content?.trim() || !category?.trim()) {
    return res.status(400).json({ error: 'Title, category, excerpt, and content are required' });
  }
  const rawSlug = slug?.trim() || title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  try {
    const post = await prisma.post.create({
      data: {
        title: sanitize(title.trim()),
        slug: rawSlug,
        category: sanitize(category.trim()),
        tags: tags ? sanitize(tags.trim()) : null,
        excerpt: sanitize(excerpt.trim()),
        content: content.trim(),
        canvasType: canvasType || 'gut',
        published: published !== false,
      }
    });
    res.status(201).json({ success: true, post });
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'A post with this slug already exists' });
    console.error('Create post error:', err);
    res.status(500).json({ error: 'Failed to create post' });
  }
});

router.put('/api/posts/:id', hybridAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid post ID' });
  const { title, slug, category, tags, excerpt, content, canvasType, published } = req.body;

  const data = {};
  if (title !== undefined) data.title = sanitize(title.trim());
  if (slug !== undefined) data.slug = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (category !== undefined) data.category = sanitize(category.trim());
  if (tags !== undefined) data.tags = tags ? sanitize(tags.trim()) : null;
  if (excerpt !== undefined) data.excerpt = sanitize(excerpt.trim());
  if (content !== undefined) data.content = content.trim();
  if (canvasType !== undefined) data.canvasType = canvasType;
  if (published !== undefined) data.published = published;

  try {
    const post = await prisma.post.update({ where: { id }, data });
    res.json({ success: true, post });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Post not found' });
    if (err.code === 'P2002') return res.status(409).json({ error: 'A post with this slug already exists' });
    console.error('Update post error:', err);
    res.status(500).json({ error: 'Failed to update post' });
  }
});

router.delete('/api/posts/:id', hybridAdminAuth, async (req, res) => {
  try {
    await prisma.post.delete({ where: { id: parseInt(req.params.id, 10) } });
    res.json({ success: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Post not found' });
    console.error('Delete post error:', err);
    res.status(500).json({ error: 'Failed to delete post' });
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
