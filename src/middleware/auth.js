const jwt = require('jsonwebtoken');
const prisma = require('../lib/prisma');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRY = process.env.JWT_EXPIRY || '7d';

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax',
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
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true }
    });
    if (!user || !user.isActive) return res.status(401).json({ error: 'Invalid session' });
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
      select: { id: true, name: true, email: true, phone: true, role: true, isActive: true }
    });
    req.user = (user && user.isActive) ? { id: user.id, name: user.name, email: user.email, phone: user.phone, role: user.role } : null;
  } catch {
    req.user = null;
  }
  next();
}

async function hybridAdminAuth(req, res, next) {
  // Try JWT cookie first
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
  // Fall back to x-admin-token header (header only — no query param to avoid token leakage in logs)
  const adminToken = req.headers['x-admin-token'];
  if (adminToken && adminToken === process.env.ADMIN_PASSWORD) {
    req.user = { id: 0, name: 'Admin', email: 'admin@theanirudhcode.com', role: 'admin' };
    return next();
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

module.exports = { generateToken, authenticate, requireAdmin, optionalAuth, hybridAdminAuth, COOKIE_OPTIONS };
