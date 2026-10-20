import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir } from '../paths.js';
import type { RateSnapshot } from './engine.js';

export interface RateLimiter {
  snapshot(now: Date): Promise<RateSnapshot>;
  record(now: Date): Promise<void>;
}

const WINDOW_MS = 60 * 60 * 1000;

async function readSends(file: string): Promise<number[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as { sends?: unknown };
    if (!Array.isArray(parsed.sends)) return [];
    return parsed.sends.map((s) => new Date(String(s)).getTime()).filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

async function writeSends(file: string, tmp: string, sends: number[]): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  await writeFile(tmp, JSON.stringify({ sends: sends.map((n) => new Date(n).toISOString()) }), { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

function prune(sends: number[], now: Date): number[] {
  const cutoff = now.getTime() - WINDOW_MS;
  return sends.filter((n) => n > cutoff).sort((a, b) => a - b);
}

/** Operations run one at a time per limiter so overlapping calls cannot interleave their file writes. */
export function createRateLimiter(file: string): RateLimiter {
  let queue: Promise<unknown> = Promise.resolve();
  let seq = 0;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    snapshot: (now) => serial(async () => {
      const sends = prune(await readSends(file), now);
      const last = sends[sends.length - 1];
      const oldest = sends[0];
      return {
        countLastHour: sends.length,
        secondsSinceLast: last === undefined ? null : Math.floor((now.getTime() - last) / 1000),
        secondsUntilWindowFrees: oldest === undefined ? 0 : Math.max(0, Math.ceil((oldest + WINDOW_MS - now.getTime()) / 1000)),
      };
    }),
    record: (now) => serial(async () => {
      const sends = prune(await readSends(file), now);
      sends.push(now.getTime());
      seq += 1;
      await writeSends(file, `${file}.${process.pid}.${seq}.tmp`, sends);
    }),
  };
}
