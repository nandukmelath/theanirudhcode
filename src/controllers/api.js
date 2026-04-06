const express = require('express');
const router = express.Router();
const prisma = require('../lib/prisma');
const { validateEmail, sanitize } = require('../middleware/validate');

// POST /api/subscribe
router.post('/subscribe', async (req, res) => {
  const { name, email, source } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

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

// POST /api/consultation
router.post('/consultation', async (req, res) => {
  const { name, email, phone, preferred_date, message } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

  try {
    await prisma.consultation.create({
      data: {
        name: sanitize(name.trim()),
        email: email.trim().toLowerCase(),
        phone: sanitize((phone || '').trim()) || null,
        preferredDate: preferred_date || null,
        message: sanitize((message || '').trim()) || null,
      }
    });

    res.status(201).json({
      success: true,
      message: 'Your consultation request has been received. We will reach out within 24 hours.'
    });
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
    res.json({ post });
  } catch (err) {
    console.error('Post detail error:', err);
    res.status(500).json({ error: 'Failed to load post' });
  }
});

module.exports = router;
