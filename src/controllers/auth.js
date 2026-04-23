const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { generateToken, authenticate, COOKIE_OPTIONS } = require('../middleware/auth');
const { validateEmail, sanitize } = require('../middleware/validate');
const { sendWelcomeEmail, sendPasswordResetEmail } = require('../lib/mailer');

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
    sendWelcomeEmail(cleanEmail, cleanName).catch(e => console.error('[Mailer] welcome email failed:', e.message));

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

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Valid email is required' });

  // Always return 200 to prevent email enumeration
  res.json({ success: true, message: 'If an account with that email exists, you will receive a reset link shortly.' });

  try {
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !user.isActive) return;

    const token    = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.passwordReset.updateMany({ where: { userId: user.id, used: false }, data: { used: true } });
    await prisma.passwordReset.create({ data: { userId: user.id, tokenHash, expiresAt } });

    const base = process.env.APP_URL || 'https://theanirudhcode.onrender.com';
    await sendPasswordResetEmail(user.email, user.name, `${base}/reset-password?token=${token}`);
  } catch (err) {
    console.error('Forgot password error:', err);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Reset token is required' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const reset = await prisma.passwordReset.findFirst({
      where: { tokenHash, used: false, expiresAt: { gt: new Date() } }
    });
    if (!reset) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

    const hash = bcrypt.hashSync(password, 10);
    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash: hash } }),
      prisma.passwordReset.update({ where: { id: reset.id }, data: { used: true } }),
    ]);

    res.clearCookie('token', { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' });
    res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
