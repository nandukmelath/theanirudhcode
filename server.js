require('dotenv').config();

// ── Fail-fast: refuse to boot without critical secrets ────────────────────────
// Auth depends on JWT_SECRET. If it's missing, every login/register would surface
// an opaque 500. Crashing here forces the deploy log to point at the real cause.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('FATAL: JWT_SECRET env var is missing or too short (need >=16 chars).');
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL env var is missing.');
  process.exit(1);
}

const express = require('express');
const cors    = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
const { startReminderScheduler } = require('./src/lib/reminders');
const prisma = require('./src/lib/prisma');

// Schema migration — idempotent, runs on every deploy, safe
async function runPaymentMigration() {
  const stmts = [
    // blocked_slots table (slot manager)
    `CREATE TABLE IF NOT EXISTS blocked_slots (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      time_start TEXT NOT NULL,
      time_end TEXT NOT NULL,
      reason TEXT,
      gcal_event_id TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      UNIQUE(date, time_start)
    )`,
    `CREATE INDEX IF NOT EXISTS blocked_slots_date_idx ON blocked_slots(date)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT true`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_id TEXT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_order_id TEXT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_gateway TEXT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`,
    `CREATE INDEX IF NOT EXISTS appt_payment_order_idx ON appointments(payment_order_id)`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_id TEXT`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_order_id TEXT`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_gateway TEXT`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS amount_paid INT`,
    `CREATE INDEX IF NOT EXISTS pord_payment_order_idx ON product_orders(payment_order_id)`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS payment_id TEXT`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS payment_order_id TEXT`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS payment_gateway TEXT`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS amount_paid INT`,
    `CREATE INDEX IF NOT EXISTS cenr_payment_order_idx ON cohort_enrollments(payment_order_id)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`,
  ];
  for (const sql of stmts) {
    await prisma.$executeRawUnsafe(sql);
  }
  console.log('[migration] Payment columns OK');
}
runPaymentMigration().catch(e => console.warn('[migration] Skipped:', e.message));

const app = express();

// Trust Railway/Cloudflare proxy so rate-limiter uses real client IP, not proxy IP
app.set('trust proxy', 1);

// ── CORS — allow Astro/Pages frontend to call the API with cookies ─────────────
const ALLOWED_ORIGINS = [
  'https://www.theanirudhcode.com',
  'https://theanirudhcode.com',
  'https://theanirudhcode.pages.dev',
  'https://heal.theanirudhcode.com',
  // dev
  'http://localhost:4321',
  'http://localhost:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    // allow server-to-server / curl (no origin) + listed origins
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: origin ${origin} not allowed`));
  },
  credentials: true,               // send cookies cross-origin
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  maxAge: 600,
}));

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'",
                   "https://cdnjs.cloudflare.com",
                   "https://checkout.razorpay.com",
                   "https://js.stripe.com",
                   "https://accounts.google.com/gsi/client",
                   "https://accounts.google.com"],
      scriptSrcAttr: ["'none'"],
      styleSrc:   ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https://checkout.razorpay.com", "https://*.stripe.com", "https://*.googleusercontent.com"],
      connectSrc: ["'self'",
                   "https://www.googleapis.com", "https://accounts.google.com",
                   "https://api.razorpay.com",
                   "https://api.stripe.com"],
      frameSrc:   ["https://checkout.razorpay.com", "https://js.stripe.com",
                   "https://hooks.stripe.com",
                   "https://accounts.google.com"],
      frameAncestors: ["'none'"],
      formAction:     ["'self'"],
      baseUri:        ["'self'"],
      objectSrc:      ["'none'"],
      upgradeInsecureRequests: [],
    }
  },
  // Strict-Transport-Security: force HTTPS for 1 year, include subdomains.
  // Enabled only in production so dev over HTTP still works.
  strictTransportSecurity: process.env.NODE_ENV === 'production'
    ? { maxAge: 365 * 24 * 60 * 60, includeSubDomains: true, preload: true }
    : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginEmbedderPolicy: false, // would block Razorpay/Stripe iframes
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // allow Google Sign-In popup to postMessage back
}));

// Disable browser features the site doesn't use (defence-in-depth against injected scripts)
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), payment=(self "https://checkout.razorpay.com" "https://js.stripe.com"), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()');
  next();
});

// Raw body for Stripe webhook — MUST be before express.json()
app.use('/api/payments/stripe/webhook', express.raw({ type: 'application/json' }));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));
app.use(cookieParser());

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// CSRF: reject non-JSON mutation requests (prevents cross-site form submissions)
function csrfGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const ct = req.headers['content-type'] || '';
  if (ct.startsWith('application/json')) return next();
  return res.status(415).json({ error: 'Content-Type must be application/json' });
}
app.use('/api', csrfGuard);
app.use('/portal-management', csrfGuard);

// Stricter rate limits for auth (must be BEFORE general API limiter)
app.use('/api/auth/login',                rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Please try again later.' } }));
app.use('/api/auth/forgot-password',      rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/auth/resend-verification',  rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/auth/reset-password',       rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/auth/register',             rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many registration attempts. Please try again later.' } }));
app.use('/api/subscribe',                 rateLimit({ windowMs: 60 * 60 * 1000, max: 8,  message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/consultation',              rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
// Payment creation: prevent order-spam (5 per 10 min per IP)
app.use('/api/payments/razorpay/create-order', rateLimit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: 'Too many payment attempts. Please try again later.' } }));
app.use('/api/payments/stripe/create-session', rateLimit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: 'Too many payment attempts. Please try again later.' } }));
app.use('/api/payments/test/complete',         rateLimit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: 'Too many payment attempts. Please try again later.' } }));
// Admin login: separate tight limit before general portal limiter
app.use('/portal-management/api/login',        rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many admin login attempts. Please try again later.' } }));

// General rate limiting for API
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
}));

// Rate limiting for admin portal
app.use('/portal-management', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
}));

// Routes (using new src/controllers)
app.use('/api', require('./src/controllers/api'));
app.use('/api/auth', require('./src/controllers/auth'));
app.use('/api/appointments', require('./src/controllers/appointments'));
app.use('/api/payments', require('./src/controllers/payments'));
app.use('/api/calendar', require('./src/controllers/calendar'));
app.use('/portal-management', require('./src/controllers/admin'));

// View pages
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'views', 'register.html')));
app.get('/my-appointments', (req, res) => res.sendFile(path.join(__dirname, 'views', 'my-appointments.html')));

// Blog pages
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'views', 'privacy.html')));
app.get('/complete-profile', (req, res) => res.sendFile(path.join(__dirname, 'views', 'complete-profile.html')));
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, 'views', 'blog-list.html')));
app.get('/blog/:slug', (req, res) => res.sendFile(path.join(__dirname, 'views', 'blog-post.html')));

app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'views', 'forgot-password.html')));
app.get('/reset-password',  (req, res) => res.sendFile(path.join(__dirname, 'views', 'reset-password.html')));
app.get('/verify-email',    (req, res) => res.sendFile(path.join(__dirname, 'views', 'verify-email.html')));

// 404 catch-all (must come after all routes)
app.use((req, res) => {
  if (req.accepts('html')) return res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
  res.status(404).json({ error: 'Not found' });
});

// Global error handler — preserve body-parser / Express HttpError status codes
// (e.g. PayloadTooLargeError → 413) instead of masking everything as 500.
app.use((err, req, res, next) => {
  const status = (err && (err.statusCode || err.status)) || 500;
  if (status >= 500) console.error('Unhandled error:', err);
  if (status === 413) {
    return res.status(413).json({ error: 'Request body too large' });
  }
  if (req.accepts('json') && req.path.startsWith('/api')) {
    return res.status(status).json({ error: err.expose ? err.message : (status >= 500 ? 'Internal server error' : 'Request rejected') });
  }
  if (req.accepts('html')) return res.status(status).sendFile(path.join(__dirname, 'views', '404.html'));
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : 'Request rejected' });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`theanirudhcode server running at http://${HOST}:${PORT}`);
  startReminderScheduler();
});
