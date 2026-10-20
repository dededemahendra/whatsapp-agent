import { randomBytes } from 'node:crypto';
import { chmod, open, readFile, rename, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { AgentError } from '../errors.js';
import { ensurePrivateDir } from '../paths.js';
import type { RateSnapshot } from './engine.js';

export interface RateLimiter {
  snapshot(now: Date): Promise<RateSnapshot>;
  record(now: Date): Promise<void>;
}

const WINDOW_MS = 60 * 60 * 1000;

/**
 * Sends recorded in the last file write. A missing file and a file that is not valid JSON both mean "no sends yet"; any other failure to read it
 * (permissions, a directory in its place) refuses the send, because counting from zero would let the agent past its own limit.
 */
async function readSends(file: string): Promise<number[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new AgentError('invalid_input', `Could not read the rate-limit state at ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) return [];
    throw e;
  }
  const sends = typeof parsed === 'object' && parsed !== null ? (parsed as { sends?: unknown }).sends : undefined;
  if (!Array.isArray(sends)) return [];
  return sends.map((s) => new Date(String(s)).getTime()).filter((n) => Number.isFinite(n));
}

let tempSeq = 0;

/** A name no other write to `file` uses: this process, a count shared by every limiter in it, and a random part for any other process that has the same pid. */
export function tempName(file: string): string {
  tempSeq += 1;
  return `${file}.${process.pid}.${tempSeq}.${randomBytes(4).toString('hex')}.tmp`;
}

async function writeSends(file: string, sends: number[]): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  const tmp = tempName(file);
  try {
    await writeFile(tmp, JSON.stringify({ sends: sends.map((n) => new Date(n).toISOString()) }), { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
}

/** How a limiter waits for the lock on its state file. The defaults are for use; tests shorten them. */
export interface LockTuning {
  /** Pause between tries. */
  retryMs: number;
  /** How long to keep trying before giving up. */
  lockWaitMs: number;
  /** A lock older than this was left by a process that died, and is broken. */
  lockStaleMs: number;
}

const DEFAULT_TUNING: LockTuning = { retryMs: 50, lockWaitMs: 5000, lockStaleMs: 30_000 };

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding `<file>.lock`, created exclusively, so processes that share the state file take turns. The lock is always removed
 * afterwards. One left by a process that died is broken once it is old enough. (Two waiters can both judge the same lock stale; that
 * needs a lock more than 30 seconds old, which only a crashed process leaves behind.)
 */
async function withLock<T>(file: string, tuning: LockTuning, fn: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  await ensurePrivateDir(path.dirname(file));
  const deadline = Date.now() + tuning.lockWaitMs;
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(lock, 'wx', 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => null);
      if (age !== null && age > tuning.lockStaleMs) {
        await unlink(lock).catch(() => undefined);
        continue;
      }
      if (Date.now() >= deadline) {
        throw new AgentError('invalid_input', `Could not lock the rate-limit state at ${file}: ${lock} has been held for more than ${Math.round(tuning.lockWaitMs / 1000)} seconds. If no whatsapp-agent process is running, delete it.`);
      }
      await pause(tuning.retryMs);
      continue;
    }
    // The holder's pid is only a note for whoever finds a stuck lock; the lock is the file's existence.
    await handle.writeFile(`${process.pid}\n`).catch(() => undefined);
    await handle.close().catch(() => undefined);
    break;
  }
  try {
    return await fn();
  } finally {
    await unlink(lock).catch(() => undefined);
  }
}

function prune(sends: number[], now: Date): number[] {
  const cutoff = now.getTime() - WINDOW_MS;
  return sends.filter((n) => n > cutoff).sort((a, b) => a - b);
}

/**
 * Operations run one at a time per limiter, and each holds the state file's lock, so limiters in this process and in other processes
 * take turns and none overwrites another's send.
 */
export function createRateLimiter(file: string, tuning: Partial<LockTuning> = {}): RateLimiter {
  const lockTuning: LockTuning = { ...DEFAULT_TUNING, ...tuning };
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => serial(() => withLock(file, lockTuning, fn));

  return {
    snapshot: (now) => exclusive(async () => {
      const sends = prune(await readSends(file), now);
      const last = sends[sends.length - 1];
      const oldest = sends[0];
      return {
        countLastHour: sends.length,
        secondsSinceLast: last === undefined ? null : Math.floor((now.getTime() - last) / 1000),
        secondsUntilWindowFrees: oldest === undefined ? 0 : Math.max(0, Math.ceil((oldest + WINDOW_MS - now.getTime()) / 1000)),
      };
    }),
    record: (now) => exclusive(async () => {
      const sends = prune(await readSends(file), now);
      sends.push(now.getTime());
      await writeSends(file, sends);
    }),
  };
}
