import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, loadPolicy, PolicySchema, savePolicy } from '../../src/policy/schema.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

describe('policy schema', () => {
  it('has safe defaults', () => {
    expect(DEFAULT_POLICY.writes.enabled).toBe(false);
    expect(DEFAULT_POLICY.writes.confirm).toBe('always');
    expect(DEFAULT_POLICY.writes.groups).toBe(false);
    expect(DEFAULT_POLICY.writes.rateLimit).toEqual({ perHour: 20, minGapSeconds: 5 });
    expect(DEFAULT_POLICY.writes.fileRoots).toEqual([]);
    expect(DEFAULT_POLICY.daemon.presenceMode).toBe('quiet');
    expect(PolicySchema.safeParse(DEFAULT_POLICY).success).toBe(true);
  });

  it('rejects unknown keys and bad values', () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, extra: 1 }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, confirm: 'sometimes' } }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, limits: { ...DEFAULT_POLICY.limits, maxResults: 5000 } }).success).toBe(false);
  });

  it('loads defaults when the file is missing', async () => {
    expect(await loadPolicy(path.join(tmp, 'nope', 'policy.json'))).toEqual(DEFAULT_POLICY);
  });

  it('saves with mode 0600 and round-trips', async () => {
    const file = path.join(tmp, 'cfg', 'policy.json');
    const p = { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true, allow: ['+61 400 000 001'] } };
    await savePolicy(file, p);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(await loadPolicy(file)).toEqual(p);
    expect(JSON.parse(await readFile(file, 'utf8')).version).toBe(1);
  });

  it('throws invalid_input for a corrupt file', async () => {
    const file = path.join(tmp, 'policy.json');
    await writeFile(file, '{"version":1,"writes":{}}');
    await expect(loadPolicy(file)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('rejects relative file roots and accepts absolute ones', () => {
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, fileRoots: ['Documents'] } }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, fileRoots: ['/tmp'] } }).success).toBe(true);
  });

  it('throws invalid_input from savePolicy for a bad policy and writes nothing', async () => {
    const file = path.join(tmp, 'cfg', 'policy.json');
    await expect(savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, allow: [''] } }))
      .rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining(file) });
    await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('throws invalid_input when the policy path cannot be read', async () => {
    const dir = path.join(tmp, 'policy.json');
    await mkdir(dir);
    await expect(loadPolicy(dir)).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('EISDIR') });
  });
});
