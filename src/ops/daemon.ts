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

  const runOnce = (): Promise<{ code: number | null; loggedOut: boolean; startedAt: number }> =>
    new Promise((resolve) => {
      const startedAt = now();
      let loggedOut = false;
      opts.log(`${stamp()} starting: ${opts.bin} ${args.join(' ')}`);
      child = spawn(opts.bin, args, { env: { ...(opts.env ?? process.env), NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      const rl = readline.createInterface({ input: child.stderr! });
      rl.on('line', (line) => {
        const ev = parseEventLine(line);
        if (ev) {
          if (ev.event === 'logged_out') loggedOut = true;
          opts.log(`${stamp()} event=${ev.event}`);
        } else if (line.trim() !== '') {
          opts.log(`${stamp()} ${line}`);
        }
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
      await sleep(delay);
      delay = Math.min(delay * 2, backoff.maxMs);
      if (stopping) return 'stopped';
    }
  })();

  return {
    done,
    async stop() {
      stopping = true;
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
