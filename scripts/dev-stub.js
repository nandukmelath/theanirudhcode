#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Local dev server with stubbed Prisma. No database needed.
 *
 * Useful for inspecting the UI / static views without a Postgres connection.
 * Persistence (login, booking, blog) won't actually save — every endpoint that
 * touches a model gets empty / fake data from the in-memory stub.
 *
 * Run:  node scripts/dev-stub.js
 */

const path = require('path');

process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'local-dev-stub-secret-not-secure-do-not-use-in-prod';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@localhost:5432/stub';
process.env.NODE_ENV     = 'development';
process.env.PORT         = process.env.PORT || '3000';
process.env.HOST         = process.env.HOST || '127.0.0.1';

const prismaPath    = require.resolve('../src/lib/prisma.js');
const remindersPath = require.resolve('../src/lib/reminders.js');
const stub = require('./smoke-prisma-stub.js');
require.cache[prismaPath]    = { id: prismaPath,    filename: prismaPath,    loaded: true, exports: stub };
require.cache[remindersPath] = { id: remindersPath, filename: remindersPath, loaded: true, exports: { startReminderScheduler: () => {} } };

console.log('\n══════════════════════════════════════════');
console.log('  theanirudhcode — local dev (stubbed DB)');
console.log('══════════════════════════════════════════');
console.log(`  URL:  http://${process.env.HOST}:${process.env.PORT}`);
console.log('  NOTE: writes do NOT persist. UI / routing only.');
console.log('══════════════════════════════════════════\n');

require('../server.js');
