const sanitizeHtml = require('sanitize-html');

// Hard caps on user-supplied text fields. Server-side belt-and-braces:
// express.json() limits the whole body to 10kb, but per-field caps give
// clean 400 errors instead of opaque DB writes / parse failures.
const LIMITS = {
  name:           120,
  email:          254,   // RFC 5321
  phone:           32,
  shortText:      500,   // tags, slug, category, subject
  message:       4000,   // consultation message
  healthConcerns: 4000,
  medicalHistory: 4000,
  goals:         2000,
  blogTitle:      200,
  blogExcerpt:    600,
  blogContent: 100000,
  password:       128,   // sanity cap; bcrypt truncates at 72 bytes anyway
};

function validateEmail(email) {
  if (typeof email !== 'string') return false;
  if (email.length > LIMITS.email) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitize(input) {
  if (!input) return '';
  return sanitizeHtml(String(input), { allowedTags: [], allowedAttributes: {} });
}

// Returns { ok:true, value } or { ok:false, error }
function checkLen(value, field, max) {
  if (typeof value !== 'string') return { ok: false, error: `${field} must be text` };
  if (value.length > max)        return { ok: false, error: `${field} is too long (max ${max} characters)` };
  return { ok: true, value };
}

// Password policy: min 8 chars, at least one letter + one digit.
// We don't force symbols/case because the docs and most security guidance
// converged on length + entropy over complexity rules. Bcrypt handles the rest.
// Common/breached password block list (top patterns — augment as needed)
const BLOCKED_PASSWORDS = new Set([
  'password','password1','password123','pass1234','12345678','123456789',
  'qwerty123','qwerty@1','letmein1','welcome1','admin1234','iloveyou1',
  'sunshine1','monkey123','dragon123','master123','abc@1234','test1234',
  'india@123','india123','anirudh123','doctor123','health123','wellness1',
]);

function validatePassword(pw) {
  if (typeof pw !== 'string' || !pw) return { ok: false, error: 'Password is required' };
  if (pw.length < 10) return { ok: false, error: 'Password must be at least 10 characters' };
  if (pw.length > LIMITS.password) return { ok: false, error: `Password too long (max ${LIMITS.password} characters)` };
  if (!/[A-Z]/.test(pw)) return { ok: false, error: 'Password must contain at least one uppercase letter (A–Z)' };
  if (!/[a-z]/.test(pw)) return { ok: false, error: 'Password must contain at least one lowercase letter (a–z)' };
  if (!/\d/.test(pw)) return { ok: false, error: 'Password must contain at least one number (0–9)' };
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(pw)) return { ok: false, error: 'Password must contain at least one special character (!@#$%^&* etc.)' };
  if (/(.)\1{3,}/.test(pw)) return { ok: false, error: 'Password must not repeat the same character 4 or more times in a row' };
  if (BLOCKED_PASSWORDS.has(pw.toLowerCase())) return { ok: false, error: 'This password is too common. Please choose a stronger one.' };
  return { ok: true };
}

function validatePhone(phone) {
  if (phone == null || phone === '') return { ok: true, value: '' };
  if (typeof phone !== 'string') return { ok: false, error: 'Phone must be text' };
  if (phone.length > LIMITS.phone) return { ok: false, error: `Phone is too long (max ${LIMITS.phone} characters)` };
  const digits = phone.replace(/[\s\-+().]/g, '');
  if (!/^\d{7,15}$/.test(digits)) return { ok: false, error: 'Please enter a valid phone number' };
  return { ok: true, value: phone };
}

module.exports = { validateEmail, sanitize, checkLen, validatePassword, validatePhone, LIMITS };
