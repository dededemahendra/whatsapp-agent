import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectDoctor, formatDoctor } from '../../src/ops/doctor.js';
import { resolvePaths } from '../../src/paths.js';
import { DEFAULT_POLICY } from '../../src/policy/schema.js';
import { createRunner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, makeTmp, removeTmp } from '../helpers/fake.js';

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

describe('doctor', () => {
  it('collects status, policy, service and paths, and lists problems', async () => {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
    const runner = createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_STORE_DIR: path.join(tmp, 'store') }) });
    const service = { install: async () => '', uninstall: async () => {}, status: async () => ({ installed: false, running: null, detail: 'not installed' }) };
    const r = await collectDoctor({ runner, policy: DEFAULT_POLICY, paths, service, now: () => new Date('2026-10-20T10:00:00Z') });
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
    const r = await collectDoctor({ runner, policy: DEFAULT_POLICY, paths, service: null, now: () => new Date() });
    expect(r.status.wacli_version).toBeNull();
    expect(r.problems[0]).toContain('wacli was not found');
  });
});

describe('doctor with a wacli older than the minimum', () => {
  it('names the old version first and does not call the store unpaired', async () => {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
    const runner = createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_VERSION: '0.21.0', FAKE_WACLI_STORE_DIR: path.join(tmp, 'store') }) });
    const r = await collectDoctor({ runner, policy: DEFAULT_POLICY, paths, service: null, now: () => new Date('2026-10-20T10:00:00Z') });
    expect(r.status).toMatchObject({ wacli_version: '0.21.0', min_version_ok: false, authenticated: false });
    expect(r.problems[0]).toBe('wacli 0.21.0 is older than the minimum 0.22.0. Fix: brew upgrade wacli');
    expect(r.problems.some((p) => p.includes('not paired'))).toBe(false);
    expect(formatDoctor(r)).toContain('below minimum');
  });
});
