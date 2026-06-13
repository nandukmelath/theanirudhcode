const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

// SameSite=None (+ Secure) required so the Astro/Pages frontend can send cookies
// cross-site to the API. On localhost dev, keep 'lax' (None requires HTTPS).
const IS_PROD = process.env.NODE_ENV === 'production';
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: IS_PROD,
  sameSite: IS_PROD ? 'none' : 'lax',
  maxAge: 7 * 24 * 60 * 60 * 1000
};

function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

async function authenticate(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Authentication required' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, passwordChangedAt: true }
    });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid session' });
    // Reject tokens issued before the most recent password change
    if (user.passwordChangedAt && payload.iat * 1000 < user.passwordChangedAt.getTime()) {
      return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    }
    req.user = { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role };
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

async function optionalAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) { req.user = null; return next(); }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: payload.id },
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true, passwordChangedAt: true }
    });
    const valid = user && user.isActive &&
      (!user.passwordChangedAt || payload.iat * 1000 >= user.passwordChangedAt.getTime());
    req.user = valid ? { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } : null;
  } catch {
    req.user = null;
  }
  next();
}

const ADMIN_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  // Explicit site-wide path. The admin_token is read under BOTH /portal-management
  // AND /api/calendar/admin/* (hybridAdminAuth), so it must be host-wide. Setting it
  // explicitly also lets logout clear it with a matching Path (RFC 6265 requires the
  // deletion cookie's Path to match the stored cookie's Path).
  path: '/',
  maxAge: 8 * 60 * 60 * 1000   // 8-hour admin session
};

// Admin session token-epoch. Bump ADMIN_TOKEN_EPOCH (any string, e.g. an integer or
// timestamp) in the deploy env to instantly invalidate ALL previously-issued admin
// tokens — the kill-switch for a leaked admin cookie or after rotating the admin
// password (which lives in env and has no in-app change event to hook). Tokens embed
// the epoch at issue time; hybridAdminAuth rejects any whose epoch != the current one.
// Unset/empty on both sides ⇒ no-op (back-compat for already-issued tokens).
function adminTokenEpoch() {
  return process.env.ADMIN_TOKEN_EPOCH || '';
}

function generateAdminToken(username) {
  return jwt.sign({ sub: username, role: 'admin', kind: 'admin-session', ep: adminTokenEpoch() }, JWT_SECRET, { expiresIn: '8h' });
}

async function hybridAdminAuth(req, res, next) {
  // 1. Dedicated admin_token cookie (set by /portal-management/api/login)
  const adminCookie = req.cookies && req.cookies.admin_token;
  if (adminCookie) {
    try {
      const payload = jwt.verify(adminCookie, JWT_SECRET);
      // Reject tokens whose embedded epoch no longer matches (revocation kill-switch).
      // `(payload.ep || '')` keeps pre-epoch tokens valid only while ADMIN_TOKEN_EPOCH
      // is unset; once it is set, all tokens lacking the current epoch are rejected.
      if (payload.kind === 'admin-session' && payload.role === 'admin' && (payload.ep || '') === adminTokenEpoch()) {
        req.user = { id: 0, name: payload.sub || 'Admin', email: 'admin@theanirudhcode.com', role: 'admin' };
        return next();
      }
    } catch {}
  }

  // 2. Patient JWT cookie with role=admin (DB admin user)
  const token = req.cookies && req.cookies.token;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = await prisma.user.findUnique({
        where: { id: payload.id },
        select: { id: true, name: true, email: true, phone: true, role: true, isActive: true }
      });
      if (user && user.isActive && user.role === 'admin') {
        req.user = { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role };
        return next();
      }
    } catch {}
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { generateToken, generateAdminToken, authenticate, requireAdmin, optionalAuth, hybridAdminAuth, COOKIE_OPTIONS, ADMIN_COOKIE_OPTIONS };
