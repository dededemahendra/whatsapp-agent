import { access } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSetup, type SetupIO } from '../../src/ops/setup.js';
import { resolvePaths } from '../../src/paths.js';
import { loadPolicy } from '../../src/policy/schema.js';
import { createRunner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, makeTmp, removeTmp } from '../helpers/fake.js';

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

function io(over: Partial<SetupIO> & { answers?: boolean[]; found?: string | null } = {}) {
  const out: string[] = [];
  const runs: string[][] = [];
  const answers = over.answers ?? [];
  const base: SetupIO = {
    ask: async () => answers.shift() ?? false,
    print: (t) => out.push(t),
    which: async () => over.found === undefined ? FAKE_WACLI : over.found,
    run: async (cmd, args) => { runs.push([cmd, ...args]); return 0; },
    exists: async (f) => access(f).then(() => true, () => false),
  };
  return { io: { ...base, ...over }, out, runs };
}

function opts(extra: Record<string, string> = {}) {
  const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
  const env = fakeEnv(extra);
  return { paths, env, makeRunner: (bin: string) => createRunner({ bin, baseEnv: env }) };
}

const service = (calls: string[]) => ({
  install: async () => { calls.push('install'); return '/svc'; },
  uninstall: async () => {},
  status: async () => ({ installed: false, running: null, detail: 'not installed' }),
});

describe('runSetup', () => {
  it('stops when wacli is missing and the person declines the install', async () => {
    const t = io({ found: null, answers: [false] });
    const ok = await runSetup({ io: t.io, ...opts(), service: null, isGlobal: true, flags: {} });
    expect(ok).toBe(false);
    expect(t.out.join('\n')).toContain('brew install openclaw/tap/wacli');
    expect(t.runs).toEqual([]);
  });

  it('runs brew install when accepted, then continues', async () => {
    let found: string | null = null;
    const t = io({ answers: [true, false], which: async () => found });
    t.io.run = async (cmd, args) => { if (cmd === 'brew') found = FAKE_WACLI; return 0; };
    const ok = await runSetup({ io: t.io, ...opts(), service: null, isGlobal: true, flags: {} });
    expect(ok).toBe(true);
  });

  it('skips auth when paired, writes the default policy, installs the service and prints host config', async () => {
    const calls: string[] = [];
    const t = io({ answers: [true] });
    const o = opts();
    const ok = await runSetup({ io: t.io, ...o, service: service(calls), isGlobal: true, flags: {} });
    expect(ok).toBe(true);
    expect(t.runs.find((r) => r[1] === 'auth')).toBeUndefined();
    expect((await loadPolicy(o.paths.policyFile)).writes.enabled).toBe(false);
    expect(calls).toEqual(['install']);
    const text = t.out.join('\n');
    expect(text).toContain('claude mcp add --scope user whatsapp -- npx -y whatsapp-agent mcp');
    expect(text).toContain('whatsapp-agent policy enable');
    expect(text).toContain('WhatsApp');
  });

  it('runs wacli auth when not paired and reports when pairing did not complete', async () => {
    const t = io({ answers: [false] });
    const ok = await runSetup({ io: t.io, ...opts({ FAKE_WACLI_EMPTY: 'auth status' }), service: null, isGlobal: true, flags: {} });
    expect(t.runs).toEqual([[FAKE_WACLI, 'auth']]);
    expect(ok).toBe(false);
    expect(t.out.join('\n')).toContain('Pairing did not complete');
  });

  it('tells a non-global install how to get the service, and honours --no-service', async () => {
    const calls: string[] = [];
    const t = io({});
    expect(await runSetup({ io: t.io, ...opts(), service: service(calls), isGlobal: false, flags: {} })).toBe(true);
    expect(calls).toEqual([]);
    expect(t.out.join('\n')).toContain('npm i -g whatsapp-agent');
    const t2 = io({});
    await runSetup({ io: t2.io, ...opts(), service: service(calls), isGlobal: true, flags: { service: false } });
    expect(calls).toEqual([]);
  });

  it('refuses an old wacli', async () => {
    const t = io({});
    expect(await runSetup({ io: t.io, ...opts({ FAKE_WACLI_VERSION: '0.21.0' }), service: null, isGlobal: true, flags: {} })).toBe(false);
    expect(t.out.join('\n')).toContain('0.22.0');
  });
});
