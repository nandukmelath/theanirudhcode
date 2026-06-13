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
    // Tier-1 profile fields (register / complete-profile)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth TIMESTAMPTZ`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS sex TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_source TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_channel TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS marketing_opt_in BOOLEAN NOT NULL DEFAULT false`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_consent_at TIMESTAMPTZ`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_id TEXT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_order_id TEXT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS payment_gateway TEXT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`,
    // TPG-2020 compliance: patient age + explicit-consent timestamp
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS patient_age INT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ`,
    // Video consult (Whereby) — room id + patient/host join URLs. Column names match
    // the (now-dead) Pages backend so a shared DB stays consistent.
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS video_room_id TEXT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS video_room_url TEXT`,
    `ALTER TABLE appointments ADD COLUMN IF NOT EXISTS video_host_url TEXT`,
    `CREATE INDEX IF NOT EXISTS appt_payment_order_idx ON appointments(payment_order_id)`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_id TEXT`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_order_id TEXT`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS payment_gateway TEXT`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`,
    `ALTER TABLE product_orders ADD COLUMN IF NOT EXISTS amount_paid INT`,
    `CREATE INDEX IF NOT EXISTS pord_payment_order_idx ON product_orders(payment_order_id)`,
    // Fasting Program enrollments live in cohort_enrollments (program + intake JSON)
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS user_id INT`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS program TEXT`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS intake JSONB`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'pending'`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS payment_id TEXT`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS payment_order_id TEXT`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS payment_gateway TEXT`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'INR'`,
    `ALTER TABLE cohort_enrollments ADD COLUMN IF NOT EXISTS amount_paid INT`,
    `CREATE INDEX IF NOT EXISTS cenr_payment_order_idx ON cohort_enrollments(payment_order_id)`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ`,
    // Booking double-booking guard at the DB layer: no two CONFIRMED appointments
    // may share the same date + start time. The check-then-insert in bookAfterPayment
    // can still race; this partial unique index makes it physically impossible
    // (2nd insert → 23505 → P2002 → handled as SLOT_TAKEN/409).
    `CREATE UNIQUE INDEX IF NOT EXISTS appt_no_double_confirmed ON appointments(date, time_start) WHERE status = 'confirmed'`,
    // Email OTP (passwordless / signup). The /api/auth/otp/{request,verify} handlers
    // query prisma.emailOtp; without this table those endpoints threw at runtime and
    // surfaced as opaque 500s. Column names mirror the EmailOtp model's @map() values.
    `CREATE TABLE IF NOT EXISTS email_otps (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL,
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'login',
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT false,
      attempts INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    )`,
    `CREATE INDEX IF NOT EXISTS email_otps_email_idx ON email_otps(email)`,
    `CREATE INDEX IF NOT EXISTS email_otps_expires_idx ON email_otps(expires_at)`,
    // Full bio fields — occupation + health concerns (JSON array)
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS occupation TEXT`,
    `ALTER TABLE users ADD COLUMN IF NOT EXISTS health_concerns TEXT`,
  ];
  // Per-statement resilience: one failing statement (e.g. a unique index that hits
  // pre-existing duplicate rows) must not abort the remaining migrations.
  for (const sql of stmts) {
    try {
      await prisma.$executeRawUnsafe(sql);
    } catch (e) {
      console.warn('[migration] statement failed (continuing):', e.message, '::', sql.slice(0, 80));
    }
  }
  console.log('[migration] Schema sync OK');
}
runPaymentMigration().catch(e => console.warn('[migration] Skipped:', e.message));

const app = express();

// Trust Railway/Cloudflare proxy so rate-limiter uses real client IP, not proxy IP
app.set('trust proxy', 1);

// ── Rate-limit client key ─────────────────────────────────────────────────────
// Requests reach Cloud Run through: client → Cloudflare edge → apex Worker (fetch)
// → Cloud Run. By the time Express sees the request, `req.ip` (even with
// trust proxy=1) often resolves to a Google/Cloudflare infrastructure IP that is
// SHARED across many visitors — so every limiter keyed on it bucketed all traffic
// together and effectively never tripped (the RATE_LIMIT_00x failures).
// Cloudflare stamps the true end-user IP in `CF-Connecting-IP`, and the apex Worker
// forwards it. Prefer that; fall back to XFF's left-most hop, then req.ip.
function clientKey(req) {
  const cf = req.headers['cf-connecting-ip'];
  if (cf) return Array.isArray(cf) ? cf[0] : String(cf).trim();
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.ip || 'unknown';
}
// Wrap express-rate-limit so every limiter shares the same client-IP resolution
// and validation is relaxed for the custom keyGenerator (we intentionally key on
// a forwarded header rather than the socket address).
const limit = (opts) => rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: clientKey,
  // Disable express-rate-limit's startup validation advisories. They are dev-time
  // warnings (e.g. "custom keyGenerator detected"), not runtime safeguards, and we
  // intentionally key on the CF-Connecting-IP header behind a trusted proxy chain.
  validate: false,
  ...opts,
});

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
    // allow server-to-server / curl (no origin) + listed origins.
    // For a DISALLOWED origin we resolve with `false` (NOT an Error). Throwing here
    // bubbles to the global error handler and surfaces as a 500; returning false makes
    // cors() simply omit the Access-Control-Allow-Origin header, so the preflight gets
    // a clean 204 and the browser blocks the cross-origin read itself. No 500.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
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
                   "https://sdk.cashfree.com",
                   "https://js.stripe.com",
                   "https://accounts.google.com/gsi/client",
                   "https://accounts.google.com"],
      scriptSrcAttr: ["'none'"],
      styleSrc:   ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https://*.cashfree.com", "https://*.stripe.com", "https://*.googleusercontent.com"],
      connectSrc: ["'self'",
                   "https://www.googleapis.com", "https://accounts.google.com",
                   "https://*.cashfree.com",
                   "https://api.stripe.com"],
      frameSrc:   ["https://*.cashfree.com",
                   "https://js.stripe.com",
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
  crossOriginEmbedderPolicy: false, // must stay false — Cashfree/Stripe open iframes
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // allow Google Sign-In popup to postMessage back
}));

// Disable browser features the site doesn't use (defence-in-depth against injected scripts)
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy',
    'geolocation=(), camera=(), microphone=(), payment=(self "https://sdk.cashfree.com"), usb=(), magnetometer=(), gyroscope=(), accelerometer=(), interest-cohort=()');
  next();
});

// ── Optional shared-secret origin gate ────────────────────────────────────────
// The rate limiter (and abuse defences) trust CF-Connecting-IP, which is only safe
// if the Cloud Run origin is reachable EXCLUSIVELY through Cloudflare. To enforce
// that at the app layer, set ORIGIN_SHARED_SECRET in Cloud Run AND have Cloudflare
// add a matching `X-Origin-Secret` request header (Transform Rule). When the env is
// set, any request without the matching header is rejected (so direct *.run.app hits
// that bypass Cloudflare — and the spoofable CF-Connecting-IP they carry — are
// dropped before reaching a handler). When the env is UNSET this is a no-op, so the
// site keeps working unchanged until the user opts in. Webhooks are exempt because
// Cashfree/Stripe call the origin directly and are authenticated by their own
// signatures, not by this gate.
const crypto = require('crypto');
const ORIGIN_SHARED_SECRET = process.env.ORIGIN_SHARED_SECRET;
if (ORIGIN_SHARED_SECRET) {
  const WEBHOOK_PATHS = ['/api/payments/cashfree/webhook', '/api/payments/stripe/webhook'];
  const secretBuf = Buffer.from(ORIGIN_SHARED_SECRET);
  app.use((req, res, next) => {
    if (WEBHOOK_PATHS.includes(req.path)) return next();
    const provided = Buffer.from(String(req.headers['x-origin-secret'] || ''));
    // Length-equality + constant-time byte compare (pad both to the same length so
    // timingSafeEqual never throws on a mismatched-length header).
    const max = Math.max(provided.length, secretBuf.length) + 1;
    const a = Buffer.concat([provided,  Buffer.alloc(max - provided.length)]);
    const b = Buffer.concat([secretBuf, Buffer.alloc(max - secretBuf.length)]);
    const ok = provided.length === secretBuf.length && crypto.timingSafeEqual(a, b);
    if (!ok) return res.status(403).json({ error: 'Forbidden' });
    next();
  });
  console.log('[security] ORIGIN_SHARED_SECRET set — enforcing X-Origin-Secret on non-webhook routes');
}

// Raw body for webhook routes — MUST be before express.json()
app.use('/api/payments/stripe/webhook',   express.raw({ type: 'application/json' }));
app.use('/api/payments/cashfree/webhook', express.raw({ type: 'application/json' }));

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

// Stricter rate limits for auth (must be BEFORE general API limiter).
// All use limit() so they key on the real client IP (CF-Connecting-IP), not a
// shared proxy address.
app.use('/api/auth/login',                limit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Please try again later.' } }));
app.use('/api/auth/forgot-password',      limit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/auth/resend-verification',  limit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/auth/reset-password',       limit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/auth/register',             limit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many registration attempts. Please try again later.' } }));
app.use('/api/auth/otp/request',          limit({ windowMs: 60 * 60 * 1000, max: 8,  message: { error: 'Too many code requests. Please try again later.' } }));
app.use('/api/auth/otp/phone-request',   limit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many phone OTP requests. Please try again later.' } }));
// Sensitive-action auth endpoints that previously inherited only the loose general
// /api limiter (100/15min). OTP-verify brute-force is otherwise bounded only by the
// per-OTP 5-attempt cap; change/delete-account bcrypt.compare a user-supplied password.
app.use('/api/auth/otp/verify',           limit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many attempts. Please try again later.' } }));
app.use('/api/auth/google',               limit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many attempts. Please try again later.' } }));
app.use('/api/auth/change-password',      limit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many attempts. Please try again later.' } }));
app.use('/api/auth/delete-account',       limit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many attempts. Please try again later.' } }));
app.use('/api/subscribe',                 limit({ windowMs: 60 * 60 * 1000, max: 8,  message: { error: 'Too many requests. Please try again later.' } }));
// Quiz/assessment lead capture sends a real report email + upserts a subscriber on
// every call — needs its own tight limit so it can't be used to email-bomb a victim
// or burn mail-provider quota under the loose general bucket.
app.use('/api/quiz/lead',                 limit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
// Public, unauthenticated cohort enroll writes PII + fires an admin WhatsApp alert.
app.use('/api/cohorts/:id/enroll',        limit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/consultation',              limit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
// Payment endpoints: prevent order-spam and verify-spam (5 per 10 min per IP)
app.use('/api/payments/cashfree/create-order', limit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: 'Too many payment attempts. Please try again later.' } }));
app.use('/api/payments/cashfree/verify',       limit({ windowMs: 10 * 60 * 1000, max: 10, message: { error: 'Too many verification attempts. Please try again later.' } }));
app.use('/api/payments/fasting/create-order',  limit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: 'Too many payment attempts. Please try again later.' } }));
app.use('/api/payments/fasting/verify',        limit({ windowMs: 10 * 60 * 1000, max: 10, message: { error: 'Too many verification attempts. Please try again later.' } }));
app.use('/api/payments/stripe/create-session', limit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: 'Too many payment attempts. Please try again later.' } }));
app.use('/api/payments/test/complete',         limit({ windowMs: 10 * 60 * 1000, max: 5, message: { error: 'Too many payment attempts. Please try again later.' } }));
// Admin login: separate tight limit before general portal limiter
app.use('/portal-management/api/login',        limit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many admin login attempts. Please try again later.' } }));

// General rate limiting for API
app.use('/api', limit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests. Please try again later.' }
}));

// Rate limiting for admin portal
app.use('/portal-management', limit({
  windowMs: 15 * 60 * 1000,
  max: 50,
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
