const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const prisma = require('../lib/prisma');
const { generateToken, authenticate, COOKIE_OPTIONS } = require('../middleware/auth');
const { validateEmail, sanitize } = require('../middleware/validate');
const { sendWelcomeEmail } = require('../lib/mailer');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, password, phone } = req.body;

  if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const cleanName = sanitize(name.trim());
  const cleanEmail = email.trim().toLowerCase();
  const rawPhone = (phone || '').trim();
  if (rawPhone) {
    const digits = rawPhone.replace(/[\s\-+().]/g, '');
    if (!/^\d{7,15}$/.test(digits)) {
      return res.status(400).json({ error: 'Please enter a valid phone number' });
    }
  }
  const cleanPhone = sanitize(rawPhone);

  try {
    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = bcrypt.hashSync(password, 10);
    const user = await prisma.user.create({
      data: {
        name: cleanName,
        email: cleanEmail,
        passwordHash: hash,
        phone: cleanPhone,
        role: 'patient',
      }
    });

    const token = generateToken(user);
    res.cookie('token', token, COOKIE_OPTIONS);

    // Send welcome email (non-blocking)
    sendWelcomeEmail(cleanEmail, cleanName).catch(() => {});

    res.status(201).json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

  try {
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid email or password' });

    if (!bcrypt.compareSync(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = generateToken(user);
    res.cookie('token', token, COOKIE_OPTIONS);
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  });
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
