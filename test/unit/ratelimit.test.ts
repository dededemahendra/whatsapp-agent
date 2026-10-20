import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentError } from '../../src/errors.js';
import { createRateLimiter, tempName } from '../../src/policy/ratelimit.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';
import { waitFor, within } from '../helpers/wait.js';

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

const t0 = new Date('2026-10-20T10:00:00Z');
const plus = (s: number) => new Date(t0.getTime() + s * 1000);

describe('rate limiter', () => {
  it('starts empty', async () => {
    const rl = createRateLimiter(path.join(tmp, 'rl.json'));
    expect(await rl.snapshot(t0)).toEqual({ countLastHour: 0, secondsSinceLast: null, secondsUntilWindowFrees: 0 });
  });

  it('counts sends inside the hour and drops older ones', async () => {
    const file = path.join(tmp, 'rl.json');
    const rl = createRateLimiter(file);
    await rl.record(t0);
    await rl.record(plus(10));
    expect(await rl.snapshot(plus(12))).toEqual({ countLastHour: 2, secondsSinceLast: 2, secondsUntilWindowFrees: 3588 });
    expect(await rl.snapshot(plus(3605))).toEqual({ countLastHour: 1, secondsSinceLast: 3595, secondsUntilWindowFrees: 5 });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sends: [t0.toISOString(), plus(10).toISOString()] });
  });

  it('survives a corrupt file', async () => {
    const file = path.join(tmp, 'rl.json');
    await writeFile(file, 'garbage');
    const rl = createRateLimiter(file);
    expect((await rl.snapshot(t0)).countLastHour).toBe(0);
    await rl.record(t0);
    expect((await rl.snapshot(t0)).countLastHour).toBe(1);
  });

  it('serialises overlapping records so none are lost', async () => {
    const file = path.join(tmp, 'rl.json');
    const rl = createRateLimiter(file);
    await Promise.all([rl.record(t0), rl.record(plus(1)), rl.record(plus(2)), rl.record(plus(3))]);
    expect((await rl.snapshot(plus(4))).countLastHour).toBe(4);
    const leftovers = (await readdir(tmp)).filter((n) => n.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('treats a file that is valid JSON of the wrong shape as empty, like a corrupt one', async () => {
    const file = path.join(tmp, 'rl.json');
    for (const body of ['null', '[]', '"text"', '42', '{"sends":"nope"}', '{}']) {
      await writeFile(file, body);
      expect((await createRateLimiter(file).snapshot(t0)).countLastHour).toBe(0);
    }
  });
});

describe('rate limiter when the state cannot be read', () => {
  const isRoot = process.getuid?.() === 0;

  it.skipIf(isRoot)('refuses to count when the file is not readable (EACCES), instead of starting from zero', async () => {
    const file = path.join(tmp, 'rl.json');
    await writeFile(file, JSON.stringify({ sends: [t0.toISOString()] }));
    await chmod(file, 0o000);
    try {
      const rl = createRateLimiter(file);
      const err = await rl.snapshot(plus(1)).catch((e: unknown) => e) as AgentError;
      expect(err).toMatchObject({ code: 'invalid_input' });
      expect(err.message.startsWith(`Could not read the rate-limit state at ${file}: `)).toBe(true);
      expect(err.message).toContain('EACCES');
      await expect(rl.record(plus(1))).rejects.toMatchObject({ code: 'invalid_input' });
    } finally {
      await chmod(file, 0o600);
    }
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ sends: [t0.toISOString()] });
  });

  it('refuses to count when the path is a directory (EISDIR), and writes nothing', async () => {
    const file = path.join(tmp, 'rl.json');
    await mkdir(file);
    const rl = createRateLimiter(file);
    await expect(rl.snapshot(t0)).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining(`Could not read the rate-limit state at ${file}: `) });
    await expect(rl.record(t0)).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await readdir(tmp)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('still starts empty when the file does not exist', async () => {
    const rl = createRateLimiter(path.join(tmp, 'missing', 'rl.json'));
    expect((await rl.snapshot(t0)).countLastHour).toBe(0);
  });
});

describe('rate limiter lock and temp files', () => {
  const lockOf = (file: string): string => `${file}.lock`;
  const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false);
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it('names every temp file differently, with this process and a random part', () => {
    const file = path.join(tmp, 'rl.json');
    const names = Array.from({ length: 200 }, () => tempName(file));
    expect(new Set(names).size).toBe(200);
    for (const n of names) expect(n).toMatch(new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${process.pid}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`));
  });

  it('lets two limiters on one file record side by side, losing no send and leaving no temp file or lock', async () => {
    const file = path.join(tmp, 'rl.json');
    const a = createRateLimiter(file);
    const b = createRateLimiter(file);
    await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 === 0 ? a : b).record(plus(i))));
    expect((await a.snapshot(plus(20))).countLastHour).toBe(12);
    expect((await b.snapshot(plus(20))).countLastHour).toBe(12);
    expect((await readdir(tmp)).sort()).toEqual(['rl.json']);
  });

  it('keeps every send when several limiters write at once', async () => {
    const file = path.join(tmp, 'rl.json');
    const limiters = Array.from({ length: 4 }, () => createRateLimiter(file));
    await Promise.all(limiters.flatMap((rl, i) => Array.from({ length: 5 }, (_, j) => rl.record(plus(i * 10 + j)))));
    expect((await limiters[0]!.snapshot(plus(60))).countLastHour).toBe(20);
    expect((await readdir(tmp)).sort()).toEqual(['rl.json']);
  });

  it('removes the lock after each operation, and after one that fails', async () => {
    const file = path.join(tmp, 'rl.json');
    const rl = createRateLimiter(file);
    await rl.record(t0);
    expect(await exists(lockOf(file))).toBe(false);
    await rl.snapshot(t0);
    expect(await exists(lockOf(file))).toBe(false);

    const broken = path.join(tmp, 'broken.json');
    await mkdir(broken);
    await expect(createRateLimiter(broken).snapshot(t0)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await exists(lockOf(broken))).toBe(false);
  });

  it('waits while another holder has the lock, then goes ahead once it is released', async () => {
    const file = path.join(tmp, 'rl.json');
    await writeFile(lockOf(file), 'held', { flag: 'wx' });
    let done = false;
    const pending = createRateLimiter(file).record(t0).then(() => { done = true; });
    await sleep(250);
    expect(done).toBe(false);
    expect(await exists(file)).toBe(false);
    await rm(lockOf(file));
    await within(pending, 3000, 'the record after the lock was released');
    expect(done).toBe(true);
    expect((await createRateLimiter(file).snapshot(t0)).countLastHour).toBe(1);
    expect(await exists(lockOf(file))).toBe(false);
  });

  it('breaks a lock that is more than 30 seconds old and carries on', async () => {
    const file = path.join(tmp, 'rl.json');
    await writeFile(lockOf(file), 'crashed', { flag: 'wx' });
    const old = new Date(Date.now() - 31_000);
    await utimes(lockOf(file), old, old);
    const t = Date.now();
    await within(createRateLimiter(file).record(t0), 3000, 'the record past a stale lock');
    expect(Date.now() - t).toBeLessThan(2000);
    expect((await createRateLimiter(file).snapshot(t0)).countLastHour).toBe(1);
    expect(await exists(lockOf(file))).toBe(false);
  });

  it('does not break a lock that is 25 seconds old, and gives up with a clear error after waiting', async () => {
    const file = path.join(tmp, 'rl.json');
    await writeFile(lockOf(file), 'busy', { flag: 'wx' });
    const recent = new Date(Date.now() - 25_000);
    await utimes(lockOf(file), recent, recent);
    const rl = createRateLimiter(file, { lockWaitMs: 300 });
    const err = await rl.snapshot(t0).catch((e: unknown) => e) as AgentError;
    expect(err).toMatchObject({ code: 'invalid_input' });
    expect(err.message).toContain(`Could not lock the rate-limit state at ${file}`);
    expect(err.message).toContain(lockOf(file));
    expect(await exists(lockOf(file))).toBe(true);
    await expect(rl.record(t0)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await exists(file)).toBe(false);
  });

  it('retries about every 50 milliseconds while it waits', async () => {
    const file = path.join(tmp, 'rl.json');
    await writeFile(lockOf(file), 'held', { flag: 'wx' });
    const t = Date.now();
    const pending = createRateLimiter(file).snapshot(t0);
    await sleep(120);
    await rm(lockOf(file));
    await within(pending, 2000, 'the snapshot once the lock went');
    expect(Date.now() - t).toBeLessThan(400);
  });

  it('serialises a snapshot behind a record that is under way in another limiter', async () => {
    const file = path.join(tmp, 'rl.json');
    const writer = createRateLimiter(file);
    const reader = createRateLimiter(file);
    const writes = Promise.all([writer.record(t0), writer.record(plus(1)), writer.record(plus(2))]);
    const seen = await reader.snapshot(plus(3));
    await writes;
    expect(seen.countLastHour).toBeGreaterThanOrEqual(0);
    expect(seen.countLastHour).toBeLessThanOrEqual(3);
    await waitFor(async () => (await readdir(tmp)).sort().join() === 'rl.json', { what: 'the directory to hold only the state file' });
  });
});

describe('rate limiter when the lock cannot be created', () => {
  const isRoot = process.getuid?.() === 0;
  const both = (rl: ReturnType<typeof createRateLimiter>) => [() => rl.snapshot(t0), () => rl.record(t0)];

  // The state file's own name is allowed, but with ".lock" added it is one character too long: creating the lock fails, and it is not EEXIST.
  it('refuses with invalid_input when the lock file itself cannot be created (its name is too long), and leaves nothing behind', async () => {
    const file = path.join(tmp, `${'x'.repeat(252)}.json`.slice(0, 252));
    expect(path.basename(file)).toHaveLength(252);
    for (const op of both(createRateLimiter(file))) {
      const err = await op().catch((e: unknown) => e) as AgentError;
      expect(err).toMatchObject({ name: 'AgentError', code: 'invalid_input' });
      expect(err.message.startsWith(`Could not lock the rate-limit state at ${file}: `)).toBe(true);
      expect(err.message).toContain('ENAMETOOLONG');
    }
    expect(await readdir(tmp)).toEqual([]);
  });

  it.skipIf(isRoot)('refuses with invalid_input when the folder cannot be made because the one above it is read-only (EACCES)', async () => {
    const parent = path.join(tmp, 'readonly');
    await mkdir(parent);
    const file = path.join(parent, 'data', 'rl.json');
    await chmod(parent, 0o500);
    try {
      for (const op of both(createRateLimiter(file))) {
        const err = await op().catch((e: unknown) => e) as AgentError;
        expect(err).toMatchObject({ name: 'AgentError', code: 'invalid_input' });
        expect(err.message.startsWith(`Could not lock the rate-limit state at ${file}: `)).toBe(true);
        expect(err.message).toContain('EACCES');
      }
    } finally {
      await chmod(parent, 0o700);
    }
    expect(await readdir(parent)).toEqual([]);
  });

  it('refuses with invalid_input when the folder cannot be made because a file is in the way, and leaves nothing behind', async () => {
    const blocker = path.join(tmp, 'blocker');
    await writeFile(blocker, 'not a folder');
    const file = path.join(blocker, 'sub', 'rl.json');
    for (const op of both(createRateLimiter(file))) {
      const err = await op().catch((e: unknown) => e) as AgentError;
      expect(err).toMatchObject({ name: 'AgentError', code: 'invalid_input' });
      expect(err.message.startsWith(`Could not lock the rate-limit state at ${file}: `)).toBe(true);
      expect(err.message).toMatch(/ENOTDIR|EEXIST/);
    }
    expect((await readdir(tmp)).sort()).toEqual(['blocker']);
  });

  it('still reports a lock that stays held as before, and a lock that is simply there as a wait', async () => {
    const file = path.join(tmp, 'rl.json');
    await writeFile(`${file}.lock`, 'busy', { flag: 'wx' });
    const err = await createRateLimiter(file, { lockWaitMs: 150 }).snapshot(t0).catch((e: unknown) => e) as AgentError;
    expect(err).toMatchObject({ code: 'invalid_input' });
    expect(err.message).toContain('has been held for more than');
  });
});
