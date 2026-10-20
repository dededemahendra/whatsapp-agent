#!/usr/bin/env node
// Fake wacli for tests. Contract: test/fixtures/README.md
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = process.env.FAKE_WACLI_FIXTURES || path.join(HERE, 'responses');
const KNOWN = [
  'groups participants list', 'chats mark-read', 'auth status', 'chats list', 'chats show',
  'messages list', 'messages search', 'messages context', 'contacts search', 'contacts resolve',
  'groups list', 'media download', 'send text', 'send file', 'send react', 'doctor', 'version', 'sync', 'auth',
];
const GLOBAL_WITH_VALUE = ['--account', '--store', '--timeout', '--lock-wait'];
const GLOBAL_BOOL = new Set(['--json', '--read-only', '--events', '--full']);

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const tokens = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (GLOBAL_WITH_VALUE.includes(a)) { i++; continue; }
  if (GLOBAL_WITH_VALUE.some((g) => a.startsWith(g + '='))) continue;
  if (GLOBAL_BOOL.has(a)) continue;
  tokens.push(a);
}
const words = [];
for (const t of tokens) { if (t.startsWith('-')) break; words.push(t); }
const joined = words.join(' ');
const key = KNOWN.find((k) => joined === k || joined.startsWith(k + ' ')) ?? joined;

if (process.env.FAKE_WACLI_LOG) {
  appendFileSync(process.env.FAKE_WACLI_LOG, JSON.stringify({
    argv,
    key,
    env: {
      WACLI_READONLY: process.env.WACLI_READONLY,
      WACLI_MEDIA_ROOTS: process.env.WACLI_MEDIA_ROOTS,
      NO_COLOR: process.env.NO_COLOR,
    },
  }) + '\n');
}

function flagValue(name) {
  const eq = argv.find((a) => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}
function fail(code, message) {
  if (asJson) process.stderr.write(JSON.stringify({ success: false, data: null, error: message }) + '\n');
  else process.stderr.write(message + '\n');
  process.exit(code);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// An old wacli does not know --read-only or --account and fails like cobra does, in plain text.
const MIN_VERSION = [0, 22, 0];
function belowMinimum(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  for (let i = 0; i < 3; i++) if (parts[i] !== MIN_VERSION[i]) return parts[i] < MIN_VERSION[i];
  return false;
}
if (belowMinimum(process.env.FAKE_WACLI_VERSION || '')) {
  const bad = argv.find((a) => a === '--read-only' || a === '--account' || a.startsWith('--account='));
  if (bad) {
    process.stderr.write(`Error: unknown flag: ${bad.split('=')[0]}\nUsage:\n  wacli <cmd> [flags]\n`);
    process.exit(1);
  }
}

const sleepMs = Number(process.env.FAKE_WACLI_SLEEP_MS || 0);
if (sleepMs > 0) await sleep(sleepMs);

if (process.env.FAKE_WACLI_FAIL) {
  const [failKey, code, message] = process.env.FAKE_WACLI_FAIL.split('|');
  if (failKey === key || failKey === '*') fail(Number(code || 1), message || 'fake failure');
}
if (process.env.FAKE_WACLI_BIG === '1') {
  await new Promise((resolve) => process.stdout.write('x'.repeat(20 * 1024 * 1024), resolve));
  process.exit(0);
}

if (key === 'version') {
  process.stdout.write((process.env.FAKE_WACLI_VERSION || '0.22.0') + '\n');
  process.exit(0);
}

if (key === 'sync') {
  let attempt = 0;
  if (process.env.FAKE_WACLI_SYNC_COUNTER) {
    const f = process.env.FAKE_WACLI_SYNC_COUNTER;
    attempt = existsSync(f) ? Number(readFileSync(f, 'utf8') || '0') : 0;
    writeFileSync(f, String(attempt + 1));
  }
  const segments = (process.env.FAKE_WACLI_SYNC || 'connected;sleep:100;exit:0').split('|');
  const steps = segments[Math.min(attempt, segments.length - 1)].split(';');
  process.on('SIGTERM', () => {
    process.stderr.write(JSON.stringify({ event: 'disconnected', data: {}, ts: Date.now() }) + '\n');
    process.exit(0);
  });
  for (const step of steps) {
    if (step.startsWith('sleep:')) { await sleep(Number(step.slice(6))); continue; }
    if (step.startsWith('exit:')) process.exit(Number(step.slice(5)));
    if (step === 'crash') process.exit(1);
    if (step === 'text') { process.stderr.write('connected; history sync 12%\n'); continue; }
    if (step.startsWith('error:')) { process.stderr.write(JSON.stringify({ event: 'error', data: { message: step.slice(6) }, ts: Date.now() }) + '\n'); continue; }
    process.stderr.write(JSON.stringify({ event: step, data: {}, ts: Date.now() }) + '\n');
  }
  process.exit(0);
}

const emptyKeys = (process.env.FAKE_WACLI_EMPTY || '').split(',').map((s) => s.trim()).filter(Boolean);
if (emptyKeys.includes(key)) {
  process.stdout.write(JSON.stringify({ success: true, data: [], error: null }) + '\n');
  process.exit(0);
}

const file = path.join(FIXTURES, key.replaceAll(' ', '_') + '.json');
if (!existsSync(file)) fail(2, `fake: no fixture for "${key}"`);
let text = readFileSync(file, 'utf8');
text = text.replaceAll('__STORE_DIR__', process.env.FAKE_WACLI_STORE_DIR || '/tmp/fake-wacli-store');

if (key === 'media download') {
  const out = flagValue('--output');
  if (!out) fail(1, 'fake: media download requires --output');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  let target = out;
  if (existsSync(out) && statSync(out).isDirectory()) target = path.join(out, (flagValue('--id') || 'MSG') + '.png');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, png);
  text = text.replaceAll('__OUTPUT__', target).replaceAll('"__BYTES__"', String(png.length));
}
if (process.env.FAKE_WACLI_WARN === 'repeated') process.stderr.write('warning: repeated send within 5 seconds\n');
process.stdout.write(text.endsWith('\n') ? text : text + '\n');
