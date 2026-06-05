const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const prisma = require('../lib/prisma');
const { generateToken, authenticate, COOKIE_OPTIONS } = require('../middleware/auth');
const { validateEmail, sanitize, validatePassword, validatePhone, checkLen, LIMITS } = require('../middleware/validate');
const { sendWelcomeEmail, sendPasswordResetEmail, sendVerificationEmail, sendOtpEmail } = require('../lib/mailer');

// POST /api/auth/register
// Allow-listed enum values for profile fields (server-side validation)
const ALLOWED_SEX = ['male','female','other','prefer_not_to_say'];
const ALLOWED_COUNTRY = ['IN','US','GB','AE','SG','AU','CA','OTHER'];
const ALLOWED_REFERRAL = ['instagram','youtube','google','friend','podcast','event','news','other'];
const ALLOWED_CHANNEL = ['email','whatsapp','sms'];
const ALLOWED_LANG = ['en','hi','te','ta'];

router.post('/register', async (req, res) => {
  const {
    name, email, password, phone,
    dateOfBirth, sex, country, city,
    referralSource, preferredChannel, language,
    marketingOptIn, privacyConsent,
  } = req.body;

  if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'Name is required' });
  const nameCheck = checkLen(name.trim(), 'Name', LIMITS.name);
  if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error });
  const phoneCheck = validatePhone((phone || '').trim());
  if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });
  if (!privacyConsent) return res.status(400).json({ error: 'Privacy Policy consent is required' });

  // Profile fields are OPTIONAL at registration (collected here OR later via
  // /complete-profile / the booking form). Validate format only when provided.
  // This keeps the lightweight booking-modal signup working while the full
  // register page can still send everything. Privacy consent stays mandatory (DPDP).
  let dob = null;
  if (dateOfBirth) {
    dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) return res.status(400).json({ error: 'Invalid date of birth' });
    const minAge = 13, maxAge = 110;
    const years = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    if (years < minAge || years > maxAge) return res.status(400).json({ error: 'Date of birth out of accepted range' });
  }
  if (sex && !ALLOWED_SEX.includes(sex)) return res.status(400).json({ error: 'Invalid sex value' });
  if (country && !ALLOWED_COUNTRY.includes(country)) return res.status(400).json({ error: 'Invalid country' });
  if (city && typeof city === 'string' && city.trim()) {
    const cityCheck = checkLen(city.trim(), 'City', LIMITS.name);
    if (!cityCheck.ok) return res.status(400).json({ error: cityCheck.error });
  }
  if (referralSource && !ALLOWED_REFERRAL.includes(referralSource)) return res.status(400).json({ error: 'Invalid referral source' });
  const channel = preferredChannel && ALLOWED_CHANNEL.includes(preferredChannel) ? preferredChannel : null;
  const lang = language && ALLOWED_LANG.includes(language) ? language : 'en';

  const cleanName = sanitize(name.trim());
  const cleanEmail = email.trim().toLowerCase();
  const cleanPhone = sanitize(phoneCheck.value);
  const cleanCity = city && city.trim() ? sanitize(city.trim()) : null;

  try {
    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

    const hash = await bcrypt.hash(password, 10);

    // Generate verification token
    const verifyToken     = crypto.randomBytes(32).toString('hex');
    const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await prisma.user.create({
      data: {
        name:                        cleanName,
        email:                       cleanEmail,
        passwordHash:                hash,
        phone:                       cleanPhone,
        role:                        'patient',
        emailVerified:               false,
        emailVerificationTokenHash:  verifyTokenHash,
        emailVerificationExpiresAt:  verifyExpiresAt,
        dateOfBirth:                 dob,
        sex,
        country,
        city:                        cleanCity,
        referralSource,
        preferredChannel:            channel,
        language:                    lang,
        marketingOptIn:              !!marketingOptIn,
        privacyConsentAt:            new Date(),
      }
    });

    // Send verification email (non-blocking)
    const base     = process.env.APP_URL || 'https://www.theanirudhcode.com';
    const verifyUrl = `${base}/api/auth/verify-email?token=${verifyToken}`;
    sendVerificationEmail(cleanEmail, cleanName, verifyUrl).catch(e => console.error('[Mailer] verification email failed:', e.message));

    res.status(201).json({ success: true, requiresVerification: true });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });

  try {
    const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid email or password' });

    // Email verification check
    if (!user.emailVerified) {
      return res.status(403).json({
        error: 'Please verify your email address before signing in. Check your inbox for the verification link.',
        code:  'EMAIL_NOT_VERIFIED',
      });
    }

    // Account lockout check
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const minutesLeft = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60000);
      return res.status(429).json({ error: `Account temporarily locked. Try again in ${minutesLeft} minute${minutesLeft !== 1 ? 's' : ''}.` });
    }

    if (!await bcrypt.compare(password, user.passwordHash)) {
      const attempts = (user.failedLoginAttempts || 0) + 1;
      const lockout  = attempts >= MAX_FAILED_ATTEMPTS;
      await prisma.user.update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: attempts,
          lockedUntil: lockout ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000) : null,
        }
      });
      if (lockout) {
        return res.status(429).json({ error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` });
      }
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Success — reset lockout state
    if (user.failedLoginAttempts > 0 || user.lockedUntil) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    }

    const token = generateToken(user);
    res.cookie('token', token, COOKIE_OPTIONS);
    const profileIncomplete = !user.country || !user.sex || !user.dateOfBirth;
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role }, profileIncomplete });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// GET /api/auth/google-config.js — client ID for Google Identity Services button
router.get('/google-config.js', (req, res) => {
  res.setHeader('Content-Type', 'application/javascript');
  const id = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
  res.send(`window.__GOOGLE_OAUTH_CLIENT_ID__ = ${JSON.stringify(id)};`);
});

// POST /api/auth/google — sign in / sign up via Google Identity Services
// Frontend sends ID token from GIS. Backend verifies with Google, find-or-creates user.
router.post('/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential || typeof credential !== 'string') return res.status(400).json({ error: 'Missing Google credential' });

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    console.error('[Google Auth] GOOGLE_OAUTH_CLIENT_ID not configured');
    return res.status(503).json({ error: 'Google sign-in is not configured' });
  }

  try {
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || !payload.email_verified) {
      return res.status(401).json({ error: 'Google account email is not verified' });
    }

    const cleanEmail = payload.email.trim().toLowerCase();
    const cleanName  = sanitize(payload.name || payload.given_name || cleanEmail.split('@')[0]);

    let user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user) {
      // Auto-create: Google has already verified the email
      const randomPwHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      user = await prisma.user.create({
        data: {
          name:             cleanName,
          email:            cleanEmail,
          passwordHash:     randomPwHash,
          phone:            null,
          role:             'patient',
          emailVerified:    true,
          privacyConsentAt: new Date(), // DPDP: consent captured via "continue with Google" notice
        }
      });
      // Welcome email (non-blocking)
      sendWelcomeEmail(cleanEmail, cleanName).catch(e => console.error('[Mailer] welcome email failed:', e.message));
    } else {
      if (!user.isActive) return res.status(401).json({ error: 'Account is disabled' });
      // Mark email verified on existing accounts that signed up via Google
      if (!user.emailVerified) {
        await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
        user.emailVerified = true;
      }
    }

    const token = generateToken(user);
    res.cookie('token', token, COOKIE_OPTIONS);
    const profileIncomplete = !user.country || !user.sex || !user.dateOfBirth;
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role }, profileIncomplete });
  } catch (err) {
    console.error('Google sign-in error:', err.message);
    res.status(401).json({ error: 'Google sign-in failed. Please try again.' });
  }
});

// ── Email OTP (passwordless / signup) ────────────────────────────────────────
// Rate-limit guard: simple in-memory token bucket per email (production swap for Redis)
const otpRequestLimits = new Map(); // email -> { count, resetAt }
const OTP_MAX_PER_HOUR = 5;
const OTP_EXPIRY_MIN = 10;
const OTP_MAX_VERIFY_ATTEMPTS = 5;

function generateOtpCode() {
  // 6-digit code, leading zeros allowed
  return String(Math.floor(crypto.randomInt(0, 1_000_000))).padStart(6, '0');
}

function hashOtp(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

function checkOtpRateLimit(email) {
  const now = Date.now();
  const entry = otpRequestLimits.get(email);
  if (!entry || entry.resetAt < now) {
    otpRequestLimits.set(email, { count: 1, resetAt: now + 60 * 60 * 1000 });
    return true;
  }
  if (entry.count >= OTP_MAX_PER_HOUR) return false;
  entry.count++;
  return true;
}

// POST /api/auth/otp/request — body: { email, name? }
router.post('/otp/request', async (req, res) => {
  const { email, name } = req.body;
  if (!email || !validateEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  const cleanEmail = email.trim().toLowerCase();

  if (!checkOtpRateLimit(cleanEmail)) {
    return res.status(429).json({ error: 'Too many code requests. Try again in an hour.' });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { email: cleanEmail } });
    const purpose = existing ? 'login' : 'register';

    // If registering, validate name
    let cleanName = null;
    if (purpose === 'register') {
      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'Name is required for new accounts' });
      }
      const nameCheck = checkLen(name.trim(), 'Name', LIMITS.name);
      if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
      cleanName = sanitize(name.trim());
    }

    if (existing && !existing.isActive) {
      return res.status(401).json({ error: 'Account is disabled' });
    }

    // Invalidate prior unused OTPs for this email
    await prisma.emailOtp.updateMany({
      where: { email: cleanEmail, used: false },
      data: { used: true }
    });

    const code = generateOtpCode();
    const codeHash = hashOtp(code);
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MIN * 60 * 1000);

    await prisma.emailOtp.create({
      data: { email: cleanEmail, codeHash, expiresAt, purpose }
    });

    // Fire-and-forget email send
    sendOtpEmail(cleanEmail, code, purpose).catch(e => console.error('[OTP] email failed:', e.message));

    // For new users, stash the name in the OTP row so verify can create the user
    if (purpose === 'register' && cleanName) {
      // Store name in a separate way — using extra OTP record metadata via purpose suffix
      // (simpler: just re-encode on verify; we'll require the user to resend name on /verify too)
    }

    res.json({ success: true, purpose, message: `Code sent to ${cleanEmail}. Check your email.` });
  } catch (err) {
    console.error('OTP request error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/otp/verify — body: { email, code, name? (for new accounts) }
router.post('/otp/verify', async (req, res) => {
  const { email, code, name, phone } = req.body;
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Invalid email' });
  if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the 6-digit code from your email' });
  }
  const cleanEmail = email.trim().toLowerCase();

  try {
    const otp = await prisma.emailOtp.findFirst({
      where: { email: cleanEmail, used: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' }
    });
    if (!otp) {
      return res.status(401).json({ error: 'No active code. Request a new one.' });
    }
    if (otp.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
      await prisma.emailOtp.update({ where: { id: otp.id }, data: { used: true } });
      return res.status(429).json({ error: 'Too many attempts. Request a new code.' });
    }

    if (hashOtp(code) !== otp.codeHash) {
      await prisma.emailOtp.update({ where: { id: otp.id }, data: { attempts: otp.attempts + 1 } });
      return res.status(401).json({ error: 'Invalid code. Try again.' });
    }

    // Code valid — mark used
    await prisma.emailOtp.update({ where: { id: otp.id }, data: { used: true } });

    let user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user) {
      // New account — name required
      if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required for new accounts' });
      const nameCheck = checkLen(name.trim(), 'Name', LIMITS.name);
      if (!nameCheck.ok) return res.status(400).json({ error: nameCheck.error });
      const phoneCheck = validatePhone((phone || '').trim());
      if (!phoneCheck.ok) return res.status(400).json({ error: phoneCheck.error });

      const randomPwHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
      user = await prisma.user.create({
        data: {
          name: sanitize(name.trim()),
          email: cleanEmail,
          passwordHash: randomPwHash,
          phone: sanitize(phoneCheck.value) || null,
          role: 'patient',
          emailVerified: true,
        }
      });
      sendWelcomeEmail(cleanEmail, user.name).catch(e => console.error('[Mailer] welcome failed:', e.message));
    } else {
      if (!user.isActive) return res.status(401).json({ error: 'Account is disabled' });
      if (!user.emailVerified) {
        await prisma.user.update({ where: { id: user.id }, data: { emailVerified: true } });
        user.emailVerified = true;
      }
    }

    const token = generateToken(user);
    res.cookie('token', token, COOKIE_OPTIONS);
    const profileIncomplete = !user.country || !user.sex || !user.dateOfBirth;
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, role: user.role }, profileIncomplete });
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/complete-profile — for Google / OTP users who skipped Tier-1 fields at signup
router.post('/complete-profile', authenticate, async (req, res) => {
  const {
    dateOfBirth, sex, country, city,
    referralSource, preferredChannel, language,
    marketingOptIn, privacyConsent,
  } = req.body;

  if (!privacyConsent) return res.status(400).json({ error: 'Privacy Policy consent is required' });

  let dob = null;
  if (dateOfBirth) {
    dob = new Date(dateOfBirth);
    if (isNaN(dob.getTime())) return res.status(400).json({ error: 'Invalid date of birth' });
    const years = (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    if (years < 13 || years > 110) return res.status(400).json({ error: 'Date of birth out of accepted range' });
  } else {
    return res.status(400).json({ error: 'Date of birth is required' });
  }
  if (!sex || !ALLOWED_SEX.includes(sex)) return res.status(400).json({ error: 'Please select sex' });
  if (!country || !ALLOWED_COUNTRY.includes(country)) return res.status(400).json({ error: 'Please select country' });
  if (!city || typeof city !== 'string' || !city.trim()) return res.status(400).json({ error: 'City is required' });
  const cityCheck = checkLen(city.trim(), 'City', LIMITS.name);
  if (!cityCheck.ok) return res.status(400).json({ error: cityCheck.error });
  if (!referralSource || !ALLOWED_REFERRAL.includes(referralSource)) return res.status(400).json({ error: 'Please tell us how you found us' });

  const channel = preferredChannel && ALLOWED_CHANNEL.includes(preferredChannel) ? preferredChannel : null;
  const lang = language && ALLOWED_LANG.includes(language) ? language : 'en';

  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: {
        dateOfBirth: dob,
        sex,
        country,
        city: sanitize(city.trim()),
        referralSource,
        preferredChannel: channel,
        language: lang,
        marketingOptIn: !!marketingOptIn,
        privacyConsentAt: new Date(),
      }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Complete profile error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token', { ...COOKIE_OPTIONS, path: '/' });
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
    const cleanEmail = email.trim().toLowerCase();
    console.log('[ForgotPwd] Looking up:', cleanEmail);
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user || !user.isActive) {
      console.log('[ForgotPwd] No active account for:', cleanEmail);
      return;
    }
    console.log('[ForgotPwd] Found user:', user.id, '— generating token');

    const token    = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.passwordReset.updateMany({ where: { userId: user.id, used: false }, data: { used: true } });
    await prisma.passwordReset.create({ data: { userId: user.id, tokenHash, expiresAt } });

    const base = process.env.APP_URL || 'https://www.theanirudhcode.com';
    const resetUrl = `${base}/reset-password?token=${token}`;
    console.log('[ForgotPwd] Sending reset email to:', user.email, '— URL base:', base);
    const sent = await sendPasswordResetEmail(user.email, user.name, resetUrl);
    console.log('[ForgotPwd] Email sent result:', sent);
  } catch (err) {
    console.error('[ForgotPwd] Error:', err.message, err.stack);
  }
});

// GET /api/auth/verify-email?token=xxx  (link from verification email)
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token || typeof token !== 'string') {
    return res.redirect('/verify-email?status=invalid');
  }
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  try {
    const user = await prisma.user.findFirst({
      where: { emailVerificationTokenHash: tokenHash }
    });
    if (!user) return res.redirect('/verify-email?status=invalid');
    if (user.emailVerified) return res.redirect('/verify-email?status=already');
    if (user.emailVerificationExpiresAt && user.emailVerificationExpiresAt < new Date()) {
      return res.redirect('/verify-email?status=expired');
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified:               true,
        emailVerificationTokenHash:  null,
        emailVerificationExpiresAt:  null,
      }
    });

    // Send welcome email now that account is confirmed (non-blocking)
    sendWelcomeEmail(user.email, user.name).catch(e => console.error('[Mailer] welcome email failed:', e.message));

    return res.redirect('/verify-email?status=success');
  } catch (err) {
    console.error('Verify email error:', err);
    return res.redirect('/verify-email?status=error');
  }
});

// POST /api/auth/resend-verification
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Valid email is required' });

  // Always return 200 (prevents email enumeration)
  res.json({ success: true, message: 'If that email is registered and unverified, a new link has been sent.' });

  try {
    const cleanEmail = email.trim().toLowerCase();
    const user = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!user || !user.isActive || user.emailVerified) return;

    const verifyToken     = crypto.randomBytes(32).toString('hex');
    const verifyTokenHash = crypto.createHash('sha256').update(verifyToken).digest('hex');
    const verifyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await prisma.user.update({
      where: { id: user.id },
      data:  { emailVerificationTokenHash: verifyTokenHash, emailVerificationExpiresAt: verifyExpiresAt }
    });

    const base      = process.env.APP_URL || 'https://www.theanirudhcode.com';
    const verifyUrl = `${base}/api/auth/verify-email?token=${verifyToken}`;
    sendVerificationEmail(cleanEmail, user.name, verifyUrl).catch(e => console.error('[Mailer] resend verification failed:', e.message));
  } catch (err) {
    console.error('[ResendVerify] Error:', err.message);
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || typeof token !== 'string') return res.status(400).json({ error: 'Reset token is required' });
  const pwCheck = validatePassword(password);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error });

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  try {
    const reset = await prisma.passwordReset.findFirst({
      where: { tokenHash, used: false, expiresAt: { gt: new Date() } }
    });
    if (!reset) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });

    const hash = await bcrypt.hash(password, 10);
    await prisma.$transaction([
      prisma.user.update({ where: { id: reset.userId }, data: { passwordHash: hash, passwordChangedAt: new Date() } }),
      prisma.passwordReset.update({ where: { id: reset.id }, data: { used: true } }),
    ]);

    res.clearCookie('token', { ...COOKIE_OPTIONS, path: '/' });
    res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/change-password (authenticated user, in-session password rotation)
router.post('/change-password', authenticate, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (typeof currentPassword !== 'string' || !currentPassword) {
    return res.status(400).json({ error: 'Current password is required' });
  }
  const pwCheck = validatePassword(newPassword);
  if (!pwCheck.ok) return res.status(400).json({ error: pwCheck.error });
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'New password must differ from current password' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid session' });
    if (!await bcrypt.compare(currentPassword, user.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: hash, passwordChangedAt: new Date() }
    });

    // Revoke current cookie — passwordChangedAt now invalidates every JWT issued before this moment.
    res.clearCookie('token', { ...COOKIE_OPTIONS, path: '/' });
    res.json({ success: true, message: 'Password updated. Please sign in again with your new password.' });
  } catch (err) {
    console.error('Change password error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /api/auth/delete-account (authenticated user, GDPR self-service)
// Requires current password to confirm intent. Removes user + cascades to password resets;
// appointments are anonymised rather than deleted so admin keeps the historical schedule.
router.post('/delete-account', authenticate, async (req, res) => {
  const { password, confirm } = req.body;
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Password is required to delete account' });
  }
  if (confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Type DELETE to confirm account removal' });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid session' });
    if (user.role === 'admin') {
      return res.status(403).json({ error: 'Admin accounts cannot be deleted from this endpoint' });
    }
    if (!await bcrypt.compare(password, user.passwordHash)) {
      return res.status(401).json({ error: 'Password is incorrect' });
    }

    // Soft-deactivate + anonymise to keep referential integrity on appointments.
    const anonEmail = `deleted-${user.id}-${Date.now()}@removed.local`;
    await prisma.$transaction([
      prisma.passwordReset.deleteMany({ where: { userId: user.id } }),
      prisma.user.update({
        where: { id: user.id },
        data: {
          isActive: false,
          name: 'Deleted user',
          email: anonEmail,
          phone: null,
          passwordHash: crypto.randomBytes(32).toString('hex'),
          passwordChangedAt: new Date(),
          emailVerificationTokenHash: null,
          emailVerificationExpiresAt: null,
        }
      }),
    ]);

    res.clearCookie('token', { ...COOKIE_OPTIONS, path: '/' });
    res.json({ success: true, message: 'Your account has been deleted.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
