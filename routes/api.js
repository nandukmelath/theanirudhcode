const express = require('express');
const router = express.Router();
const db = require('../database/connection');
const { validateEmail, sanitize } = require('../middleware/validate');

// POST /api/subscribe
router.post('/subscribe', (req, res) => {
  const { name, email, source } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

  const cleanName = sanitize(name.trim());
  const cleanEmail = email.trim().toLowerCase();
  const cleanSource = sanitize(source || 'free-guide');

  try {
    const existing = db.prepare('SELECT id FROM subscribers WHERE email = ?').get(cleanEmail);
    if (existing) {
      return res.status(409).json({ error: 'This email is already subscribed', alreadySubscribed: true });
    }

    db.prepare('INSERT INTO subscribers (name, email, source) VALUES (?, ?, ?)').run(cleanName, cleanEmail, cleanSource);

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
router.post('/consultation', (req, res) => {
  const { name, email, phone, preferred_date, message } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

  try {
    db.prepare(
      'INSERT INTO consultations (name, email, phone, preferred_date, message) VALUES (?, ?, ?, ?, ?)'
    ).run(
      sanitize(name.trim()),
      email.trim().toLowerCase(),
      sanitize((phone || '').trim()),
      preferred_date || null,
      sanitize((message || '').trim())
    );

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
router.get('/posts', (req, res) => {
  try {
    const { category } = req.query;
    let posts;
    if (category) {
      posts = db.prepare(
        'SELECT id, title, slug, category, tags, excerpt, canvas_type, created_at FROM posts WHERE published = 1 AND category = ? ORDER BY created_at DESC'
      ).all(category);
    } else {
      posts = db.prepare(
        'SELECT id, title, slug, category, tags, excerpt, canvas_type, created_at FROM posts WHERE published = 1 ORDER BY created_at DESC'
      ).all();
    }
    res.json({ posts });
  } catch (err) {
    console.error('Posts list error:', err);
    res.status(500).json({ error: 'Failed to load posts' });
  }
});

// GET /api/posts/:slug
router.get('/posts/:slug', (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM posts WHERE slug = ? AND published = 1').get(req.params.slug);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json({ post });
  } catch (err) {
    console.error('Post detail error:', err);
    res.status(500).json({ error: 'Failed to load post' });
  }
});

module.exports = router;
