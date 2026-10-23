import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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

  it('leaves exactly one file and no temp file when two saves run at once, still owner-only', async () => {
    const file = path.join(tmp, 'cfg', 'policy.json');
    const a = { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, allow: ['+61 400 000 001'] } };
    const b = { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, allow: ['+61 400 000 002'] } };
    await Promise.all([savePolicy(file, a), savePolicy(file, b)]);
    expect(await readdir(path.dirname(file))).toEqual(['policy.json']);
    expect([a, b]).toContainEqual(await loadPolicy(file));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('removes its temp file when the rename fails', async () => {
    const dir = path.join(tmp, 'cfg');
    const file = path.join(dir, 'policy.json');
    await mkdir(file, { recursive: true }); // a directory where the file belongs, so the rename cannot succeed
    await expect(savePolicy(file, DEFAULT_POLICY)).rejects.toBeDefined();
    expect((await readdir(dir)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('throws invalid_input when the policy path cannot be read', async () => {
    const dir = path.join(tmp, 'policy.json');
    await mkdir(dir);
    await expect(loadPolicy(dir)).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('EISDIR') });
  });

  it('tells the person what to run when the policy cannot be used', async () => {
    const hint = 'Run whatsapp-agent doctor.';
    const bad = path.join(tmp, 'bad.json');
    await writeFile(bad, 'not json');
    await expect(loadPolicy(bad)).rejects.toMatchObject({ code: 'invalid_input', message: `${bad} is not valid JSON. ${hint}` });

    const wrong = path.join(tmp, 'wrong.json');
    await writeFile(wrong, '{"version":1}');
    const invalid = (await loadPolicy(wrong).catch((e: unknown) => e)) as Error;
    expect(invalid.message).toMatch(new RegExp(`^${wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is invalid: .+\\. Run whatsapp-agent doctor\\.$`));

    const dir = path.join(tmp, 'dir.json');
    await mkdir(dir);
    await expect(loadPolicy(dir)).rejects.toMatchObject({ message: `${dir} could not be read (EISDIR). ${hint}` });
  });

  it('leaves the hint off the errors savePolicy raises about a policy it was handed', async () => {
    const file = path.join(tmp, 'cfg', 'policy.json');
    const err = (await savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, allow: [''] } }).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain('doctor');
  });

  describe('daemon.staleThreshold', () => {
    const withThreshold = (staleThreshold: string) => ({ ...DEFAULT_POLICY, daemon: { ...DEFAULT_POLICY.daemon, staleThreshold } });
    const LIMIT = /daemon\.staleThreshold: .*at most 2 minutes.*120.*1m.*2m/;

    it.each(['2m', '1m', '120s', '119s', '90s', '30s', '5s', '1s', '0s', '007s'])('accepts %s', (value) => {
      expect(PolicySchema.safeParse(withThreshold(value)).success).toBe(true);
    });

    it.each(['121s', '200s', '99999999999999999999s', '3m', '5m', '10m', '0m', '01m', '3', '1h', '2h', '1.5m', '-5s', '+5s', '', 's', 'm', ' 2m', '2m ', '2 m', '2M', '120S', '1m30s'])('refuses %j and names the limit', (value) => {
      const result = PolicySchema.safeParse(withThreshold(value));
      expect(result.success).toBe(false);
      if (!result.success) {
        const message = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        expect(message).toMatch(LIMIT);
      }
    });

    it('is reported by loadPolicy with the file, the field and the limit', async () => {
      const file = path.join(tmp, 'policy.json');
      await writeFile(file, JSON.stringify(withThreshold('10m')));
      const err = (await loadPolicy(file).catch((e: unknown) => e)) as Error;
      expect(err.message).toContain(file);
      expect(err.message).toMatch(LIMIT);
    });

    it('is refused by savePolicy before anything is written', async () => {
      const file = path.join(tmp, 'cfg', 'policy.json');
      await expect(savePolicy(file, withThreshold('3m'))).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(LIMIT) });
      await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('keeps the default inside the limit', () => {
      expect(PolicySchema.safeParse(DEFAULT_POLICY).success).toBe(true);
      expect(DEFAULT_POLICY.daemon.staleThreshold).toBe('2m');
    });
  });
});
