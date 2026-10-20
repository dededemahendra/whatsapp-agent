import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/policy/ratelimit.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';

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
});
