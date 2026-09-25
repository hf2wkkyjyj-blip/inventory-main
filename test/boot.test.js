'use strict';
// Boots server.js with its external dependencies stubbed, to catch failures that
// `node --check` cannot: a const used before its declaration line, a missing
// require, a startup step throwing. Several of those have been silent before
// because startup steps are wrapped in try/catch — so this also fails if any
// startup step logs an error.

const Module = require('module');
const path   = require('path');

const routes = [];
const errors = [];

// ── Stubs ────────────────────────────────────────────────────────────────────
function fakeStatement(sql) {
  // Aggregates always yield exactly one row in real SQLite.
  const isCount = /\bCOUNT\s*\(/i.test(sql);
  return {
    all: () => [],
    get: () => (isCount ? { n: 0, count: 0, c: 0 } : undefined),
    run: () => ({ changes: 0, lastInsertRowid: 1 }),
  };
}
class FakeDatabase {
  constructor() {}
  exec() {}
  prepare(sql) { return fakeStatement(String(sql || '')); }
  close() {}
}

function fakeExpress() {
  const app = {};
  for (const verb of ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'use', 'all']) {
    app[verb] = (p, ...handlers) => { if (typeof p === 'string') routes.push(`${verb.toUpperCase()} ${p}`); return app; };
  }
  app.listen = (_port, cb) => { if (typeof cb === 'function') cb(); return { close() {} }; };
  app.set = () => app;
  return app;
}
fakeExpress.json       = () => (req, res, next) => next && next();
fakeExpress.urlencoded = () => (req, res, next) => next && next();
fakeExpress.static     = () => (req, res, next) => next && next();
fakeExpress.Router     = () => fakeExpress();

const STUBS = {
  'express':           fakeExpress,
  'node-sqlite3-wasm': { Database: FakeDatabase },
  'bcryptjs':          { hashSync: () => 'x', compareSync: () => true, hash: async () => 'x', compare: async () => true },
  'jsonwebtoken':      { sign: () => 't', verify: () => ({}) },
  'multer':            Object.assign(() => ({ single: () => (q, s, n) => n(), array: () => (q, s, n) => n() }), { memoryStorage: () => ({}), diskStorage: () => ({}) }),
  'puppeteer-core':    { launch: async () => ({}) },
  'node-imap':         function Imap() {},
  'mailparser':        { simpleParser: async () => ({}) },
  'dotenv':            { config: () => ({}) },
};

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request];
  return originalLoad.apply(this, [request, ...rest]);
};

// Never actually schedule the background jobs.
global.setInterval = () => 0;
global.setTimeout  = () => 0;

// Capture startup errors that try/catch would otherwise hide.
const origError = console.error;
console.error = (...a) => { errors.push(a.map(String).join(' ')); };
const origLog = console.log;
console.log = () => {};

let bootError = null;
try {
  require(path.join(__dirname, '..', 'server.js'));
} catch (e) {
  bootError = e;
} finally {
  console.error = origError;
  console.log   = origLog;
}

let passed = 0, failed = 0;
const check = (n, c, d) => {
  if (c) { passed++; console.log(`  ✅ ${n}`); }
  else   { failed++; console.log(`  ❌ ${n}${d ? ` — ${d}` : ''}`); }
};

console.log('\n── server.js boots ──');
check('module loads without throwing', !bootError, bootError && (bootError.stack || bootError.message));
check('no startup step logged an error', errors.length === 0, errors.join(' | '));

console.log('\n── routes registered ──');
for (const r of [
  'GET /api/admin/bot-items',
  'GET /api/admin/sku-products',
  'POST /api/admin/sku-products/save',
  'POST /api/admin/sku-products/accept',
  'DELETE /api/admin/sku-aliases',
  'DELETE /api/admin/bot-items/by-name',
  'POST /api/bot/orders',
  'GET /api/products',
]) check(r, routes.includes(r));

console.log(`\n${'─'.repeat(60)}`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
