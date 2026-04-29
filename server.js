require('dotenv').config();
const express = require('express');
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

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'",
                   "https://cdnjs.cloudflare.com",
                   "https://checkout.razorpay.com",
                   "https://js.stripe.com"],
      scriptSrcAttr: ["'none'"],
      styleSrc:   ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https://checkout.razorpay.com", "https://*.stripe.com"],
      connectSrc: ["'self'",
                   "https://www.googleapis.com", "https://accounts.google.com",
                   "https://api.razorpay.com",
                   "https://api.stripe.com"],
      frameSrc:   ["https://checkout.razorpay.com", "https://js.stripe.com",
                   "https://hooks.stripe.com"],
    }
  }
}));

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
app.use('/api/auth/login',          rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many login attempts. Please try again later.' } }));
app.use('/api/auth/forgot-password', rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/auth/register',        rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many registration attempts. Please try again later.' } }));
app.use('/api/subscribe',            rateLimit({ windowMs: 60 * 60 * 1000, max: 8,  message: { error: 'Too many requests. Please try again later.' } }));
app.use('/api/consultation',         rateLimit({ windowMs: 60 * 60 * 1000, max: 5,  message: { error: 'Too many requests. Please try again later.' } }));

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
  max: 200,
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
app.get('/blog', (req, res) => res.sendFile(path.join(__dirname, 'views', 'blog-list.html')));
app.get('/blog/:slug', (req, res) => res.sendFile(path.join(__dirname, 'views', 'blog-post.html')));

app.get('/forgot-password', (req, res) => res.sendFile(path.join(__dirname, 'views', 'forgot-password.html')));
app.get('/reset-password',  (req, res) => res.sendFile(path.join(__dirname, 'views', 'reset-password.html')));

// Manifesto page
app.get('/manifesto', (req, res) => res.sendFile(path.join(__dirname, 'public', 'manifesto.html')));

// 404 catch-all (must come after all routes)
app.use((req, res) => {
  if (req.accepts('html')) return res.status(404).sendFile(path.join(__dirname, 'views', '404.html'));
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (req.accepts('html')) return res.status(500).sendFile(path.join(__dirname, 'views', '404.html'));
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`theanirudhcode server running at http://${HOST}:${PORT}`);
  startReminderScheduler();
});
