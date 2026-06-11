const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { validateEmail, sanitize, checkLen, validatePhone, LIMITS } = require('../middleware/validate');
const wa = require('../lib/whatsapp');
const { sendQuizResultEmail, QUIZ_ARCHETYPES } = require('../lib/mailer');
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

// POST /api/subscribe
router.post('/subscribe', async (req, res) => {
  const { name, email, source } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const nameCheck = checkLen(name.trim(), 'Name', LIMITS.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  const srcCheck = checkLen(typeof source === 'string' ? source : 'free-guide', 'Source', LIMITS.shortText);
  if (!srcCheck.ok) return res.status(400).json({ error: srcCheck.error });

  const cleanName = sanitize(name.trim());
  const cleanEmail = email.trim().toLowerCase();
  const cleanSource = sanitize(source || 'free-guide');

  try {
    const existing = await prisma.subscriber.findUnique({ where: { email: cleanEmail } });
    if (existing) {
      return res.status(409).json({ error: 'This email is already subscribed', alreadySubscribed: true });
    }

    await prisma.subscriber.create({
      data: { name: cleanName, email: cleanEmail, source: cleanSource }
    });

    res.status(201).json({
      success: true,
      message: 'Welcome to the healing journey! Check your email for the guide.'
    });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/quiz/lead — "Meet the Real You" metabolic assessment lead capture.
// Stores/refreshes the subscriber and emails the full personalised report.
// The archetype is computed client-side; we validate it against the known set.
router.post('/quiz/lead', async (req, res) => {
  const { name, email, archetype } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const nameCheck = checkLen(name.trim(), 'Name', LIMITS.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (!archetype || typeof archetype !== 'string' || !Object.prototype.hasOwnProperty.call(QUIZ_ARCHETYPES, archetype)) {
    return res.status(400).json({ error: 'Invalid assessment result' });
  }

  const cleanName = sanitize(name.trim());
  const cleanEmail = email.trim().toLowerCase();
  const source = `metabolic-quiz:${archetype}`;

  try {
    // Upsert — a retake or an existing subscriber just refreshes the source/name,
    // never errors. The point is the lead + the emailed report, not uniqueness.
    await prisma.subscriber.upsert({
      where: { email: cleanEmail },
      update: { name: cleanName, source, isActive: true },
      create: { name: cleanName, email: cleanEmail, source },
    });

    res.status(201).json({ success: true, message: 'Your full report is on its way to your inbox.' });

    // Fire the report email after responding — non-blocking.
    sendQuizResultEmail(cleanEmail, cleanName, archetype)
      .catch((e) => console.error('[Quiz] result email failed:', e.message));
  } catch (err) {
    console.error('Quiz lead error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/consultation
router.post('/consultation', async (req, res) => {
  const { name, email, phone, preferred_date, message, health_concerns, age } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const nameCheck = checkLen(name.trim(), 'Name', LIMITS.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (preferred_date && (typeof preferred_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(preferred_date.trim()))) {
    return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD.' });
  }
  if (message != null && message !== '') {
    const msgCheck = checkLen(message, 'Message', LIMITS.message);
    if (!msgCheck.ok) return res.status(400).json({ error: msgCheck.error });
  }
  // health_concerns is an optional discrete field (some clients send it separately
  // instead of folding it into `message`). Bound its length; it gets HTML-stripped
  // by sanitize() below before storage, same as every other free-text field.
  if (health_concerns != null && health_concerns !== '') {
    const hcCheck = checkLen(String(health_concerns), 'Health concerns', LIMITS.healthConcerns);
    if (!hcCheck.ok) return res.status(400).json({ error: hcCheck.error });
  }
  // Age: optional, but if supplied it must be a plausible human age. Rejects the
  // negative / >120 values a scanner probes with (VALIDATION_001).
  let ageNum = null;
  if (age != null && age !== '') {
    ageNum = Number(age);
    if (!Number.isInteger(ageNum) || ageNum < 1 || ageNum > 120) {
      return res.status(400).json({ error: 'Please enter a valid age between 1 and 120.' });
    }
  }
  const phoneCheck = validatePhone((phone || '').trim());
  if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });

  // Build the stored message: fold age + health_concerns (when sent discretely) into
  // the free-text note so admin sees them, and so they pass through HTML sanitisation.
  const baseMsg = (message || '').trim();
  const extras = [];
  if (ageNum != null) extras.push(`Age: ${ageNum}`);
  if (health_concerns != null && String(health_concerns).trim()) extras.push(`Concerns: ${String(health_concerns).trim()}`);
  const composedMsg = [baseMsg, ...extras].filter(Boolean).join('\n');

  try {
    await prisma.consultation.create({
      data: {
        name: sanitize(name.trim()),
        email: email.trim().toLowerCase(),
        phone: sanitize((phone || '').trim()) || null,
        preferredDate: preferred_date ? sanitize(preferred_date.trim()) : null,
        message: sanitize(composedMsg) || null,
      }
    });

    res.status(201).json({
      success: true,
      message: 'Your consultation request has been received. We will reach out within 24 hours.'
    });

    // Notify admin + patient via WhatsApp (non-blocking, after response sent)
    const consult = { name: sanitize(name.trim()), email: email.trim().toLowerCase(), phone: sanitize((phone || '').trim()) || null, message: sanitize(composedMsg) || null };
    wa.sendAdminConsultationAlert(consult).catch(e => console.error('[WhatsApp] consultation alert failed:', e.message));
    if (consult.phone) wa.sendConsultationAck(consult.phone, consult.name).catch(e => console.error('[WhatsApp] consultation ack failed:', e.message));
  } catch (err) {
    console.error('Consultation error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/posts
router.get('/posts', async (req, res) => {
  try {
    const { category } = req.query;
    const where = { published: true };
    if (category) where.category = category;

    const posts = await prisma.post.findMany({
      where,
      select: { id: true, title: true, slug: true, category: true, tags: true, excerpt: true, canvasType: true, createdAt: true },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ posts });
  } catch (err) {
    console.error('Posts list error:', err);
    res.status(500).json({ error: 'Failed to load posts' });
  }
});

// GET /api/posts/:slug
router.get('/posts/:slug', async (req, res) => {
  try {
    const post = await prisma.post.findUnique({ where: { slug: req.params.slug } });
    if (!post || !post.published) return res.status(404).json({ error: 'Post not found' });
    res.json({ post: { ...post, content: sanitizeHtml(post.content, BLOG_SAFE) } });
  } catch (err) {
    console.error('Post detail error:', err);
    res.status(500).json({ error: 'Failed to load post' });
  }
});

// /api/products endpoints removed — store cut

// GET /api/cohorts
router.get('/cohorts', async (req, res) => {
  try {
    const cohorts = await prisma.cohort.findMany({
      where: { isActive: true },
      orderBy: { startDate: 'asc' },
    });
    res.json({ cohorts });
  } catch (err) {
    console.error('Cohorts error:', err);
    res.status(500).json({ error: 'Failed to load cohorts' });
  }
});

// POST /api/cohorts/:id/enroll
router.post('/cohorts/:id/enroll', async (req, res) => {
  const cohortId = parseInt(req.params.id, 10);
  if (!cohortId || cohortId < 1) return res.status(400).json({ error: 'Invalid cohort' });

  const { name, email, phone, message } = req.body;
  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const nameCheck = checkLen(name.trim(), 'Name', LIMITS.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Valid email is required' });
  const phoneCheck = validatePhone((phone || '').trim());
  if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });
  if (message != null && message !== '') {
    const msgCheck = checkLen(message, 'Message', LIMITS.message);
    if (!msgCheck.ok) return res.status(400).json({ error: msgCheck.error });
  }

  try {
    const cohort = await prisma.cohort.findUnique({ where: { id: cohortId } });
    if (!cohort || !cohort.isActive) return res.status(404).json({ error: 'Program not found' });

    const existing = await prisma.cohortEnrollment.findFirst({
      where: { cohortId, email: email.trim().toLowerCase() }
    });
    if (existing) return res.status(409).json({ error: 'You are already enrolled in this program.' });

    await prisma.cohortEnrollment.create({
      data: {
        cohortId,
        name:    sanitize(name.trim()),
        email:   email.trim().toLowerCase(),
        phone:   sanitize((phone || '').trim()) || null,
        message: sanitize((message || '').trim()) || null,
      }
    });

    wa.sendAdminConsultationAlert({
      name: sanitize(name.trim()),
      email: email.trim().toLowerCase(),
      phone: sanitize((phone || '').trim()) || null,
      message: `Cohort enrollment: "${cohort.name}" — ₹${cohort.price}`,
    }).catch(e => console.error('[WhatsApp] admin alert failed:', e.message));

    res.status(201).json({ success: true, message: `You have been added to the waitlist for "${cohort.name}". We will reach out with next steps!` });
  } catch (err) {
    console.error('Cohort enroll error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
