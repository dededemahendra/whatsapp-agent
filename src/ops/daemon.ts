import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { Policy } from '../policy/schema.js';

export function buildSyncArgs(account: string | null, d: Policy['daemon']): string[] {
  return [
    ...(account ? ['--account', account] : []),
    'sync', '--follow',
    `--presence-mode=${d.presenceMode}`,
    `--send-spacing=${d.sendSpacing}`,
    `--stale-threshold=${d.staleThreshold}`,
    '--max-reconnect=0',
    `--max-db-size=${d.maxDbSize}`,
    '--refresh-contacts', '--refresh-groups',
    ...(d.downloadMedia ? ['--download-media'] : []),
    '--events',
  ];
}

export function parseEventLine(line: string): { event: string; data?: unknown } | null {
  const t = line.trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t) as { event?: unknown; data?: unknown };
    return typeof o.event === 'string' ? { event: o.event, data: o.data } : null;
  } catch {
    return null;
  }
}

const EVENT_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_PLAIN_LINE = 500;
const MAX_ERROR_MESSAGE = 200;
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e]/g;
const JID = /(?<![\w.+-])\+?\d[\d:-]*@[A-Za-z0-9.-]+/g;

function safeLine(line: string): string {
  const stripped = line.replace(CONTROLS, '');
  return stripped.length > MAX_PLAIN_LINE ? `${stripped.slice(0, MAX_PLAIN_LINE)}... (${stripped.length} chars)` : stripped;
}

/** A wacli error message made fit for a log: no controls, no JIDs or runs of 8 or more digits (they identify people), at most 200 characters. */
function safeMessage(message: string): string {
  return message.replace(CONTROLS, '').replace(JID, '<jid>').replace(/\d{8,}/g, '<number>').trim().slice(0, MAX_ERROR_MESSAGE);
}

function stringField(o: unknown, key: string): string | null {
  const v = typeof o === 'object' && o !== null ? (o as Record<string, unknown>)[key] : undefined;
  return typeof v === 'string' ? v : null;
}

/** The error of a wacli failure envelope, `{"success":false,"error":"..."}`, or null when the line is not one. */
function failureError(t: string): string | null {
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t) as Record<string, unknown>;
    return o.success === false ? stringField(o, 'error') : null;
  } catch {
    return null;
  }
}

/**
 * What one wacli stderr line contributes to the daemon log. Never a message body and never an unbounded line.
 * A recognised event logs its name only, except an error event, which also logs its message (wacli reports
 * failures this way under --events). A wacli failure envelope logs its error the same way. Error messages lose
 * control characters, JIDs and long numbers and stop at 200 characters. Any other line that looks like JSON
 * (it starts with `{`, `[` or `"`, or contains `{"`) becomes a placeholder with its length. Plain lines lose
 * control characters and are capped at 500 characters.
 */
export function describeStderrLine(line: string): { text: string | null; event: string | null } {
  const t = line.trim();
  if (t === '') return { text: null, event: null };
  const ev = parseEventLine(line);
  if (ev) {
    if (!EVENT_NAME.test(ev.event)) return { text: 'event=(unrecognised name)', event: null };
    const message = ev.event === 'error' ? safeMessage(stringField(ev.data, 'message') ?? '') : '';
    return { text: message === '' ? `event=${ev.event}` : `error: ${message}`, event: ev.event };
  }
  const failure = failureError(t);
  if (failure !== null && safeMessage(failure) !== '') return { text: `wacli error: ${safeMessage(failure)}`, event: null };
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"') || t.includes('{"')) {
    return { text: `(unrecognised json line, ${line.length} chars)`, event: null };
  }
  return { text: safeLine(line), event: null };
}

export interface SupervisorOptions {
  bin: string;
  account: string | null;
  daemon: Policy['daemon'];
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
  backoff?: { initialMs: number; maxMs: number; resetAfterMs: number };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface SupervisorHandle {
  stop(): Promise<void>;
  done: Promise<'logged_out' | 'stopped'>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function startSupervisor(opts: SupervisorOptions): SupervisorHandle {
  const backoff = opts.backoff ?? { initialMs: 5_000, maxMs: 60_000, resetAfterMs: 10 * 60_000 };
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const stamp = () => new Date(now()).toISOString();
  const args = buildSyncArgs(opts.account, opts.daemon);

  let child: ChildProcess | null = null;
  let stopping = false;
  let delay = backoff.initialMs;
  let requestStop: () => void = () => {};
  const stopRequested = new Promise<void>((resolve) => { requestStop = resolve; });

  const runOnce = (): Promise<{ code: number | null; loggedOut: boolean; startedAt: number }> =>
    new Promise((resolve) => {
      const startedAt = now();
      let loggedOut = false;
      opts.log(`${stamp()} starting: ${opts.bin} ${args.join(' ')}`);
      child = spawn(opts.bin, args, { env: { ...(opts.env ?? process.env), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const rl = readline.createInterface({ input: child.stderr! });
      rl.on('line', (line) => {
        const d = describeStderrLine(line);
        if (d.event === 'logged_out') loggedOut = true;
        if (d.text !== null) opts.log(`${stamp()} ${d.text}`);
      });
      child.stdout?.on('data', () => { /* sync prints nothing useful on stdout */ });
      child.on('error', (err) => opts.log(`${stamp()} spawn error: ${err.message}`));
      child.on('close', (code) => { child = null; resolve({ code, loggedOut, startedAt }); });
    });

  const done = (async (): Promise<'logged_out' | 'stopped'> => {
    for (;;) {
      const r = await runOnce();
      if (stopping) return 'stopped';
      if (r.loggedOut) {
        opts.log(`${stamp()} WhatsApp revoked the linked session. Not restarting. Run: whatsapp-agent setup`);
        return 'logged_out';
      }
      if (now() - r.startedAt >= backoff.resetAfterMs) delay = backoff.initialMs;
      opts.log(`${stamp()} sync exited with code ${r.code ?? 'signal'}; restarting in ${delay} ms`);
      await Promise.race([sleep(delay), stopRequested]);
      delay = Math.min(delay * 2, backoff.maxMs);
      if (stopping) return 'stopped';
    }
  })();

  return {
    done,
    async stop() {
      stopping = true;
      requestStop();
      opts.log(`${stamp()} stop requested`);
      const c = child;
      if (c && c.exitCode === null) {
        c.kill('SIGTERM');
        const t = setTimeout(() => { if (c.exitCode === null) c.kill('SIGKILL'); }, 10_000);
        await new Promise<void>((r) => c.once('close', () => { clearTimeout(t); r(); }));
      }
      await done;
    },
  };
}
