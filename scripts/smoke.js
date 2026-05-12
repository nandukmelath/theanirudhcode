#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Local smoke test: boots the Express app in-process with a stubbed Prisma
 * client (no real DB needed) and hits a handful of endpoints to confirm
 * routing, middleware, and security headers are wired correctly.
 *
 * Run:  node scripts/smoke.js
 */

const path = require('path');

// 1. Stub env BEFORE requiring server modules
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'smoke-test-secret-key-do-not-use-in-prod';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://smoke:smoke@localhost:5432/smoke';
process.env.NODE_ENV     = 'test';
process.env.PORT         = '0';   // tell server.js to pick any port (we override listen anyway)

// 2. Pre-populate require.cache so prisma + reminders are stubbed before server.js loads
const prismaPath    = require.resolve('../src/lib/prisma.js');
const remindersPath = require.resolve('../src/lib/reminders.js');
const stub = require('./smoke-prisma-stub.js');
require.cache[prismaPath]    = { id: prismaPath,    filename: prismaPath,    loaded: true, exports: stub };
require.cache[remindersPath] = { id: remindersPath, filename: remindersPath, loaded: true, exports: { startReminderScheduler: () => {} } };

// 3. Intercept listen so server.js doesn't bind a port
const realListen = require('http').Server.prototype.listen;
require('http').Server.prototype.listen = function () { this._smokeListenIntercepted = true; return this; };

// 4. Capture the express app created inside server.js
const realExpress = require('express');
let capturedApp = null;
function wrappedExpress(...args) {
  const a = realExpress.apply(this, args);
  capturedApp = a;
  return a;
}
Object.setPrototypeOf(wrappedExpress, realExpress);
for (const k of Object.keys(realExpress)) wrappedExpress[k] = realExpress[k];
require.cache[require.resolve('express')].exports = wrappedExpress;

// 5. Boot server.js
try {
  require('../server.js');
} catch (e) {
  console.error('FAIL: server.js threw on boot:', e);
  process.exit(1);
}

require('http').Server.prototype.listen = realListen;

if (!capturedApp) { console.error('FAIL: did not capture express app instance'); process.exit(1); }

// 6. Spin up a real HTTP server using the captured app, on an ephemeral port
const http = require('http');
const server = http.createServer(capturedApp);
server.listen(0, '127.0.0.1', runTests);

async function runTests() {
  const port = server.address().port;
  let pass = 0, fail = 0;

  function hit({ method, path: p, body, contentType, expectStatus, expectHeaders, expectBodyIncludes, label }) {
    return new Promise((resolve) => {
      const headers = {};
      if (body) {
        headers['Content-Type'] = contentType || 'application/json';
        if (typeof body === 'string') headers['Content-Length'] = Buffer.byteLength(body);
      }
      const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
        let buf = '';
        res.on('data', c => buf += c);
        res.on('end', () => {
          const reasons = [];
          if (expectStatus && res.statusCode !== expectStatus) reasons.push(`status=${res.statusCode}!=${expectStatus}`);
          if (expectHeaders) {
            for (const [k, v] of Object.entries(expectHeaders)) {
              const got = res.headers[k.toLowerCase()];
              const ok = v instanceof RegExp ? (got && v.test(got)) : (got && got.includes(v));
              if (!ok) reasons.push(`header[${k}]=${JSON.stringify(got)} did not match ${v}`);
            }
          }
          if (expectBodyIncludes && !buf.includes(expectBodyIncludes)) {
            reasons.push(`body did not include ${JSON.stringify(expectBodyIncludes)}; body=${buf.slice(0,160)}`);
          }
          if (reasons.length === 0) { pass++; console.log(`  PASS  ${label}`); }
          else                      { fail++; console.log(`  FAIL  ${label}\n        ${reasons.join('\n        ')}`); }
          resolve();
        });
      });
      req.on('error', (e) => { fail++; console.log(`  FAIL  ${label}  request error: ${e.message}`); resolve(); });
      if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
      req.end();
    });
  }

  await hit({ label: 'GET /  → 200 + CSP + Permissions-Policy + Referrer-Policy + nosniff',
    method: 'GET', path: '/',
    expectStatus: 200,
    expectHeaders: {
      'content-security-policy':    /default-src 'self'/,
      'referrer-policy':            'strict-origin',
      'permissions-policy':         /camera=\(\)/,
      'x-content-type-options':     'nosniff',
    }
  });

  await hit({ label: 'GET /nonexistent-page-xyz  → 404',
    method: 'GET', path: '/nonexistent-page-xyz', expectStatus: 404 });

  await hit({ label: 'POST /api/auth/register  (missing fields)  → 400',
    method: 'POST', path: '/api/auth/register', body: {},
    expectStatus: 400, expectBodyIncludes: 'Name is required' });

  await hit({ label: 'POST /api/auth/register  (weak password no digit)  → 400 needs number',
    method: 'POST', path: '/api/auth/register',
    body: { name: 'Test User', email: 'test@example.com', password: 'lettersonly' },
    expectStatus: 400, expectBodyIncludes: 'number' });

  await hit({ label: 'POST /api/auth/register  (bad email)  → 400',
    method: 'POST', path: '/api/auth/register',
    body: { name: 'Test User', email: 'not-an-email', password: 'goodpass1' },
    expectStatus: 400, expectBodyIncludes: 'email' });

  await hit({ label: 'POST /api/auth/register  (name 200 chars)  → 400 too long',
    method: 'POST', path: '/api/auth/register',
    body: { name: 'x'.repeat(200), email: 'a@b.com', password: 'goodpass1' },
    expectStatus: 400, expectBodyIncludes: 'too long' });

  await hit({ label: 'POST /api/subscribe  (no name)  → 400',
    method: 'POST', path: '/api/subscribe', body: { email: 'a@b.com' },
    expectStatus: 400, expectBodyIncludes: 'Name' });

  await hit({ label: 'POST /api/auth/login  form-encoded  → 415 CSRF guard',
    method: 'POST', path: '/api/auth/login', body: 'email=a&password=b',
    contentType: 'application/x-www-form-urlencoded',
    expectStatus: 415 });

  await hit({ label: 'GET /api/auth/me  (no cookie)  → 401',
    method: 'GET', path: '/api/auth/me', expectStatus: 401 });

  await hit({ label: 'POST /api/auth/change-password  (no auth)  → 401',
    method: 'POST', path: '/api/auth/change-password',
    body: { currentPassword: 'x', newPassword: 'goodpass1' }, expectStatus: 401 });

  await hit({ label: 'POST /api/auth/delete-account  (no auth)  → 401',
    method: 'POST', path: '/api/auth/delete-account',
    body: { password: 'x', confirm: 'DELETE' }, expectStatus: 401 });

  await hit({ label: 'GET /api/posts  → 200 [] (stub)',
    method: 'GET', path: '/api/posts', expectStatus: 200, expectBodyIncludes: 'posts' });

  await hit({ label: 'GET /login  → 200 HTML',
    method: 'GET', path: '/login', expectStatus: 200, expectBodyIncludes: 'Welcome' });

  await hit({ label: 'GET /register  → 200 HTML',
    method: 'GET', path: '/register', expectStatus: 200, expectBodyIncludes: 'Begin' });

  await hit({ label: 'GET /my-appointments  → 200 HTML',
    method: 'GET', path: '/my-appointments', expectStatus: 200, expectBodyIncludes: 'Account' });

  await hit({ label: 'POST oversized body (>10kb)  → 413',
    method: 'POST', path: '/api/auth/register',
    body: JSON.stringify({ name: 'x'.repeat(20000), email: 'a@b.com', password: 'goodpass1' }),
    expectStatus: 413 });

  await hit({ label: 'POST /api/appointments/book  unauthenticated  → 401',
    method: 'POST', path: '/api/appointments/book',
    body: { date: '2027-01-01', time_start: '10:00', time_end: '11:00', health_concerns: 'x' },
    expectStatus: 401 });

  await hit({ label: 'GET /portal-management  → 200 HTML (login screen)',
    method: 'GET', path: '/portal-management', expectStatus: 200 });

  server.close();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
