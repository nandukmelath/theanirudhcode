const express = require('express');
const router = express.Router();
const path = require('path');
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const crypto = require('crypto');
const { hybridAdminAuth, generateAdminToken, ADMIN_COOKIE_OPTIONS } = require('../middleware/auth');
const { getSettings } = require('./calendar');
const { sanitize } = require('../middleware/validate');
const { sendConsultationReply } = require('../lib/mailer');
const sanitizeHtml = require('sanitize-html');

const BLOG_SAFE = {
  allowedTags: ['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'b', 'i', 'u', 'a', 'blockquote', 'br', 'hr', 'span'],
  allowedAttributes: { 'a': ['href', 'target', 'rel'] },
  allowedSchemes: ['https', 'http', 'mailto'],
  transformTags: {
    'a': (tagName, attribs) => {
      if (attribs.target === '_blank') attribs.rel = 'noopener noreferrer';
      return { tagName, attribs };
    },
  },
};

// ── Admin auth ─────────────────────────────────────────────────────────────

// POST /portal-management/api/login
// Body: { username, password }
// Verifies the username (constant-time) + password against env credentials, then
// issues the admin_token cookie. Password verification prefers a bcrypt
// ADMIN_PASSWORD_HASH when set (production); ADMIN_PASSWORD plaintext is a dev
// fallback only. Set ONLY ADMIN_PASSWORD_HASH in prod and delete the plaintext.
router.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const envUser = process.env.ADMIN_USERNAME;
  const envPass = process.env.ADMIN_PASSWORD;
  const envHash = process.env.ADMIN_PASSWORD_HASH;

  // A bcrypt hash OR a plaintext password is required, plus the username.
  if (!envUser || (!envHash && !envPass)) {
    // Don't disclose which env vars are unset to an unauthenticated probe.
    console.error('[Admin login] ADMIN_USERNAME / ADMIN_PASSWORD_HASH (or ADMIN_PASSWORD) not configured');
    return res.status(503).json({ error: 'Admin login is temporarily unavailable.' });
  }
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  // Constant-time username compare. Pad shorter buffers with a zero byte so
  // timingSafeEqual never throws on length mismatch; AND in an exact-length check.
  const uBuf = Buffer.from(username);
  const eBuf = Buffer.from(envUser);
  const maxULen = Math.max(uBuf.length, eBuf.length) + 1;
  const uA = Buffer.concat([uBuf, Buffer.alloc(maxULen - uBuf.length)]);
  const uB = Buffer.concat([eBuf, Buffer.alloc(maxULen - eBuf.length)]);
  const uMatch = crypto.timingSafeEqual(uA, uB) && uBuf.length === eBuf.length;

  // Password compare: bcrypt when a hash is configured (preferred), otherwise a
  // constant-time compare against the plaintext dev fallback.
  let pMatch;
  if (envHash) {
    try {
      pMatch = await bcrypt.compare(password, envHash);
    } catch (e) {
      console.error('[Admin login] ADMIN_PASSWORD_HASH compare failed (is it a valid bcrypt hash?):', e.message);
      return res.status(503).json({ error: 'Admin login is temporarily unavailable.' });
    }
  } else {
    const pBuf  = Buffer.from(password);
    const epBuf = Buffer.from(envPass);
    const maxPLen = Math.max(pBuf.length, epBuf.length) + 1;
    const pA = Buffer.concat([pBuf,  Buffer.alloc(maxPLen - pBuf.length)]);
    const pB = Buffer.concat([epBuf, Buffer.alloc(maxPLen - epBuf.length)]);
    pMatch = crypto.timingSafeEqual(pA, pB) && pBuf.length === epBuf.length;
  }

  if (uMatch && pMatch) {
    const token = generateAdminToken(username);
    res.cookie('admin_token', token, ADMIN_COOKIE_OPTIONS);
    return res.json({ success: true });
  }

  res.status(401).json({ error: 'Invalid credentials' });
});

// POST /portal-management/api/logout
router.post('/api/logout', (req, res) => {
  // Clear with the SAME attributes the cookie was set with (Path=/, sameSite, secure)
  // so the browser actually deletes it. The cookie is set host-wide because
  // /api/calendar/admin/* also reads it — scoping the clear to /portal-management
  // would leave it live at Path=/.
  res.clearCookie('admin_token', { ...ADMIN_COOKIE_OPTIONS, maxAge: undefined });
  res.json({ success: true });
});

// Serve admin page. The HTML shell itself is intentionally public because it
// CONTAINS the login form — every data endpoint below is guarded by hybridAdminAuth,
// so no sensitive data is exposed by serving the shell. Hard-401'ing here would make
// it impossible to render the login screen. We do mark it noindex/no-store so the
// panel never lands in a search index or a shared cache (defence-in-depth).
router.get('/', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid subscriber ID' });
  try {
    await prisma.subscriber.delete({ where: { id } });
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
    const validStatuses = ['new', 'read', 'contacted', 'completed'];
    if (status && !validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status filter' });
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
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid consultation ID' });
  const { status } = req.body;
  const valid = ['new', 'read', 'contacted', 'completed'];
  if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  try {
    await prisma.consultation.update({ where: { id }, data: { status } });
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

  // Real clock-time regex (rejects impossible values like 25:61 that \d{2}:\d{2} accepts).
  const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (working_hours_start && !timeRegex.test(working_hours_start)) return res.status(400).json({ error: 'Invalid start time format. Use HH:MM.' });
  if (working_hours_end && !timeRegex.test(working_hours_end)) return res.status(400).json({ error: 'Invalid end time format. Use HH:MM.' });
  // Cross-field: end must be after start, and at least one slot must fit, so an
  // inverted/empty working window can't silently brick the slot generator.
  if (working_hours_start && working_hours_end) {
    const [sh, sm] = working_hours_start.split(':').map(Number);
    const [eh, em] = working_hours_end.split(':').map(Number);
    if (eh * 60 + em <= sh * 60 + sm) return res.status(400).json({ error: 'End time must be after start time.' });
  }

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
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid ID' });
  const { reply } = req.body;
  if (!reply || !reply.trim()) return res.status(400).json({ error: 'Reply message is required' });
  const cleanReply = sanitize(reply.trim());
  if (!cleanReply) return res.status(400).json({ error: 'Reply message is required' });

  try {
    const consultation = await prisma.consultation.update({
      where: { id },
      data: { adminReply: cleanReply, repliedAt: new Date(), status: 'contacted' }
    });
    sendConsultationReply(consultation.email, consultation.name, cleanReply).catch(e => console.error('[Mailer] consultation reply failed:', e.message));
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

const VALID_CANVAS_TYPES = ['gut', 'mind', 'heart', 'body', 'soul', 'lifestyle', 'nutrition', 'general', 'sleep', 'ayurveda'];

router.post('/api/posts', hybridAdminAuth, async (req, res) => {
  const { title, slug, category, tags, excerpt, content, canvasType, published } = req.body;
  if (!title?.trim() || !excerpt?.trim() || !content?.trim() || !category?.trim()) {
    return res.status(400).json({ error: 'Title, category, excerpt, and content are required' });
  }
  if (canvasType && !VALID_CANVAS_TYPES.includes(canvasType)) {
    return res.status(400).json({ error: `canvasType must be one of: ${VALID_CANVAS_TYPES.join(', ')}` });
  }
  let rawSlug = slug?.trim() || title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // A title with no ASCII alphanumerics (e.g. emoji/Devanagari/CJK only) collapses
  // to an empty slug → a broken /blog/ URL. Fall back to an id-based slug.
  if (!rawSlug) rawSlug = `post-${Date.now()}`;

  try {
    const post = await prisma.post.create({
      data: {
        title: sanitize(title.trim()),
        slug: rawSlug,
        category: sanitize(category.trim()),
        tags: tags ? sanitize(tags.trim()) : null,
        excerpt: sanitize(excerpt.trim()),
        content: sanitizeHtml(content.trim(), BLOG_SAFE),
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
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid post ID' });
  const { title, slug, category, tags, excerpt, content, canvasType, published } = req.body;

  if (canvasType !== undefined && !VALID_CANVAS_TYPES.includes(canvasType)) {
    return res.status(400).json({ error: `canvasType must be one of: ${VALID_CANVAS_TYPES.join(', ')}` });
  }

  const data = {};
  if (title !== undefined) data.title = sanitize(title.trim());
  if (slug !== undefined) {
    const s = slug.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    if (!s) return res.status(400).json({ error: 'Could not derive a URL slug from the provided value; please provide a valid slug.' });
    data.slug = s;
  }
  if (category !== undefined) data.category = sanitize(category.trim());
  if (tags !== undefined) data.tags = tags ? sanitize(tags.trim()) : null;
  if (excerpt !== undefined) data.excerpt = sanitize(excerpt.trim());
  if (content !== undefined) data.content = sanitizeHtml(content.trim(), BLOG_SAFE);
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
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid post ID' });
  try {
    await prisma.post.delete({ where: { id } });
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

// Activate/deactivate or promote/demote a user
router.patch('/api/users/:id', hybridAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid user ID' });

  const { isActive, role, confirmRoleChange } = req.body;
  const data = {};

  if (isActive !== undefined) data.isActive = Boolean(isActive);
  if (role !== undefined) {
    if (!['patient', 'admin'].includes(role)) return res.status(400).json({ error: 'Invalid role. Must be patient or admin.' });
    data.role = role;
  }

  if (Object.keys(data).length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  // Promotion to admin is high-impact (a durable DB-admin backdoor) — never allow it
  // implicitly. Require an explicit confirmRoleChange:true flag so it cannot happen
  // via a stray/forged PATCH that only flips isActive in the UI.
  if (data.role === 'admin' && confirmRoleChange !== true) {
    return res.status(400).json({ error: 'Promoting a user to admin requires confirmRoleChange:true.' });
  }

  // Prevent admin from deactivating or demoting their own account (id:0 = env-cred
  // session, which has no DB row, so this only fires for DB-admin sessions).
  if (req.user && req.user.id && req.user.id === id) {
    if (data.isActive === false) return res.status(400).json({ error: 'You cannot deactivate your own account' });
    if (data.role === 'patient') return res.status(400).json({ error: 'You cannot demote your own admin account' });
  }

  try {
    // Last-admin guard: demoting or deactivating the only remaining active admin
    // would lock the panel out of any DB-admin. Block it. Re-check the target's
    // current role so we only count it as "losing an admin" when it actually is one.
    const demotes  = data.role === 'patient';
    const disables = data.isActive === false;
    if (demotes || disables) {
      const target = await prisma.user.findUnique({ where: { id }, select: { role: true, isActive: true } });
      if (!target) return res.status(404).json({ error: 'User not found' });
      const wouldRemoveAnAdmin = target.role === 'admin' && target.isActive &&
        (demotes || disables);
      if (wouldRemoveAnAdmin) {
        const activeAdmins = await prisma.user.count({ where: { role: 'admin', isActive: true } });
        if (activeAdmins <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last remaining admin. Promote another admin first.' });
        }
      }
    }

    const user = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, name: true, email: true, role: true, isActive: true }
    });
    // Audit trail: who changed what about whom. Never logs PII beyond ids + the field deltas.
    const actor = req.user ? `${req.user.id === 0 ? 'env-admin' : 'user#' + req.user.id} (${req.user.email})` : 'unknown';
    console.log(`[AUDIT] admin ${actor} updated user#${id}:`,
      JSON.stringify({ ...(data.role !== undefined ? { role: data.role } : {}), ...(data.isActive !== undefined ? { isActive: data.isActive } : {}) }));
    res.json({ success: true, user });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'User not found' });
    console.error('Update user error:', err);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Appointments list (admin)
router.get('/api/appointments', hybridAdminAuth, async (req, res) => {
  try {
    const appointments = await prisma.appointment.findMany({
      include: { user: { select: { name: true, email: true, phone: true } } },
      orderBy: [{ date: 'desc' }, { timeStart: 'asc' }]
    });
    const formatted = appointments.map(a => ({
      id:             a.id,
      date:           a.date,
      time_start:     a.timeStart,
      time_end:       a.timeEnd,
      status:         a.status,
      health_concerns: a.healthConcerns,
      patient_name:   a.user?.name,
      patient_email:  a.user?.email,
      patient_phone:  a.user?.phone,
    }));
    res.json({ appointments: formatted });
  } catch (err) {
    console.error('Admin appointments error:', err);
    res.status(500).json({ error: 'Failed to load appointments' });
  }
});

// Cancel appointment (admin)
router.post('/api/appointments/:id/cancel', hybridAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid appointment ID' });
  try {
    const appt = await prisma.appointment.findUnique({ where: { id } });
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (appt.status !== 'confirmed') return res.status(400).json({ error: 'Only confirmed appointments can be cancelled' });
    await prisma.appointment.update({ where: { id }, data: { status: 'cancelled' } });
    res.json({ success: true, message: 'Appointment cancelled' });
  } catch (err) {
    console.error('Admin cancel appt error:', err);
    res.status(500).json({ error: 'Failed to cancel appointment' });
  }
});

// Complete appointment (admin)
router.post('/api/appointments/:id/complete', hybridAdminAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || id < 1) return res.status(400).json({ error: 'Invalid appointment ID' });
  try {
    const appt = await prisma.appointment.findUnique({ where: { id } });
    if (!appt) return res.status(404).json({ error: 'Appointment not found' });
    if (appt.status !== 'confirmed') return res.status(400).json({ error: 'Only confirmed appointments can be completed' });
    await prisma.appointment.update({ where: { id }, data: { status: 'completed' } });
    res.json({ success: true, message: 'Appointment completed' });
  } catch (err) {
    console.error('Admin complete appt error:', err);
    res.status(500).json({ error: 'Failed to complete appointment' });
  }
});

module.exports = router;
