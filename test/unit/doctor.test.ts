import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorCommand } from '../../src/ops/doctor-cmd.js';
import { collectDoctor, formatDoctor } from '../../src/ops/doctor.js';
import { resolvePaths } from '../../src/paths.js';
import { DEFAULT_POLICY } from '../../src/policy/schema.js';
import { createRunner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, FIXTURES, fakeEnv, makeTmp, removeTmp } from '../helpers/fake.js';

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); vi.unstubAllEnvs(); });

describe('doctor', () => {
  it('collects status, policy, service and paths, and lists problems', async () => {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
    const runner = createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_STORE_DIR: path.join(tmp, 'store') }) });
    const service = { install: async () => '', uninstall: async () => {}, status: async () => ({ installed: false, running: null, detail: 'not installed' }) };
    const r = await collectDoctor({ runner, policyFile: paths.policyFile, paths, service, now: () => new Date('2026-10-20T10:00:00Z') });
    expect(r.status.authenticated).toBe(true);
    expect(r.service).toEqual({ installed: false, running: null, detail: 'not installed' });
    expect(r.problems).toEqual(['The sync daemon is not installed. Reads will go stale. Run: whatsapp-agent daemon install']);
    const text = formatDoctor(r);
    expect(text).toContain('wacli: 0.22.0');
    expect(text).toContain('paired: yes (+61400000000)');
    expect(text).toContain('writes: disabled');
  });

  it('reports a missing wacli as a problem', async () => {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
    const runner = createRunner({ bin: path.join(tmp, 'nope'), baseEnv: fakeEnv() });
    const r = await collectDoctor({ runner, policyFile: paths.policyFile, paths, service: null, now: () => new Date() });
    expect(r.status.wacli_version).toBeNull();
    expect(r.problems[0]).toContain('wacli was not found');
  });
});

describe('doctor with a wacli older than the minimum', () => {
  it('names the old version first and does not call the store unpaired', async () => {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
    const runner = createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_VERSION: '0.21.0', FAKE_WACLI_STORE_DIR: path.join(tmp, 'store') }) });
    const r = await collectDoctor({ runner, policyFile: paths.policyFile, paths, service: null, now: () => new Date('2026-10-20T10:00:00Z') });
    expect(r.status).toMatchObject({ wacli_version: '0.21.0', min_version_ok: false, authenticated: false });
    expect(r.problems[0]).toBe('wacli 0.21.0 is older than the minimum 0.22.0. Fix: brew upgrade wacli');
    expect(r.problems.some((p) => p.includes('not paired'))).toBe(false);
    expect(formatDoctor(r)).toContain('below minimum');
  });
});

describe('doctor with a corrupt policy', () => {
  function setup() {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
    const runner = createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_STORE_DIR: path.join(tmp, 'store') }) });
    return { paths, runner };
  }

  it('lists the file and the error as a problem while the other checks still run', async () => {
    const { paths, runner } = setup();
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.policyFile, '{"nope":1}');
    const r = await collectDoctor({ runner, policyFile: paths.policyFile, paths, service: null, now: () => new Date('2026-10-20T10:00:00Z') });
    expect(r.policy).toBeNull();
    expect(r.status).toMatchObject({ wacli_version: '0.22.0', authenticated: true });
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(paths.policyFile);
    expect(r.problems[0]).toContain('is invalid');
    const text = formatDoctor(r);
    expect(text).toContain('Problems:');
    expect(text).toContain('writes: unknown');
    expect(text).toContain('paired: yes');
  });

  it('names the file when it is not valid JSON, and lists nothing about the allowlist', async () => {
    const { paths, runner } = setup();
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.policyFile, 'not json');
    const r = await collectDoctor({ runner, policyFile: paths.policyFile, paths, service: null, now: () => new Date() });
    expect(r.problems).toEqual([`${paths.policyFile} is not valid JSON`]);
  });

  it('runs as a command with exit code 1, reads the account without loading deps, and creates no directories', async () => {
    const { paths } = setup();
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.policyFile, '{"nope":1}');
    vi.stubEnv('WHATSAPP_AGENT_CONFIG_DIR', paths.configDir);
    vi.stubEnv('WHATSAPP_AGENT_DATA_DIR', paths.dataDir);
    vi.stubEnv('WHATSAPP_AGENT_WACLI_BIN', FAKE_WACLI);
    vi.stubEnv('FAKE_WACLI_FIXTURES', FIXTURES);
    vi.stubEnv('FAKE_WACLI_STORE_DIR', path.join(tmp, 'store'));
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const before = process.exitCode;
    try {
      await doctorCommand({ service: () => null }).parseAsync(['--json'], { from: 'user' });
      const report = JSON.parse(out.mock.calls.map((c) => String(c[0])).join('')) as { policy: unknown; problems: string[]; status: { authenticated: boolean } };
      expect(report.policy).toBeNull();
      expect(report.status.authenticated).toBe(true);
      expect(report.problems[0]).toContain(paths.policyFile);
      expect(process.exitCode).toBe(1);
    } finally {
      out.mockRestore();
      process.exitCode = before;
    }
    await expect(stat(paths.dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('doctor with an inert allowlist entry', () => {
  it('names the policy remove command in the hint', async () => {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
    await mkdir(paths.configDir, { recursive: true });
    await writeFile(paths.policyFile, JSON.stringify({ ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, allow: ['Alice "A" $x', '+61 400 000 001'] } }));
    const runner = createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_STORE_DIR: path.join(tmp, 'store') }) });
    const r = await collectDoctor({ runner, policyFile: paths.policyFile, paths, service: null, now: () => new Date() });
    expect(r.problems).toEqual([
      'Allowlist entry "Alice "A" $x" is not a phone number or JID and never matches. Remove it with: whatsapp-agent policy remove "Alice \\"A\\" \\$x", then add the person with: whatsapp-agent policy allow <number or JID>',
    ]);
  });
});

describe('doctor with a service that is installed but stopped', () => {
  it('tells the person to restart it with daemon install', async () => {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
    const runner = createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_STORE_DIR: path.join(tmp, 'store') }) });
    const service = { install: async () => '', uninstall: async () => {}, status: async () => ({ installed: true, running: false, detail: 'installed, inactive' }) };
    const r = await collectDoctor({ runner, policyFile: paths.policyFile, paths, service, now: () => new Date() });
    expect(r.problems).toEqual(['The sync daemon is installed but not running. Restart it with: whatsapp-agent daemon install']);
  });
});
