require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const path = require('path');
const { startReminderScheduler } = require('./src/lib/reminders');

const app = express();

// Trust Railway/Cloudflare proxy so rate-limiter uses real client IP, not proxy IP
app.set('trust proxy', 1);

// Security headers
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'none'"],
      styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://www.googleapis.com", "https://accounts.google.com"]
    }
  }
}));

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
