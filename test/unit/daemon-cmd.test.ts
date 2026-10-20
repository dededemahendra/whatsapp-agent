import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonCommand, type DaemonCommandDeps } from '../../src/ops/daemon-cmd.js';
import type { ServiceManager, ServiceStatus } from '../../src/ops/service-types.js';
import { formatAge } from '../../src/ops/text.js';
import { createRunner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, fixturesWith, makeTmp, readArgvLog, removeTmp } from '../helpers/fake.js';

let tmp: string;
beforeEach(async () => {
  tmp = await makeTmp();
  vi.stubEnv('HOME', tmp);
  vi.stubEnv('WHATSAPP_AGENT_CONFIG_DIR', path.join(tmp, 'config'));
  vi.stubEnv('WHATSAPP_AGENT_DATA_DIR', path.join(tmp, 'data'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTmp(tmp);
});

/** A service manager that only records what it is asked, so no launchctl or systemctl ever runs. */
function stubService(status: ServiceStatus) {
  const calls: string[] = [];
  const manager: ServiceManager = {
    install: async () => { calls.push('install'); return '/svc'; },
    uninstall: async () => { calls.push('uninstall'); },
    status: async () => status,
  };
  return { calls, service: () => manager };
}

/** Runs `whatsapp-agent daemon <args>` in this process and returns what it printed and its exit code. */
async function run(args: string[], deps: DaemonCommandDeps): Promise<{ out: string; err: string; exitCode: number | string | undefined }> {
  let out = '';
  let err = '';
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out += String(c); return true; });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err += String(c); return true; });
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await daemonCommand(deps).parseAsync(args, { from: 'user' });
    return { out, err, exitCode: process.exitCode };
  } finally {
    so.mockRestore();
    se.mockRestore();
    process.exitCode = before;
  }
}

describe('daemon uninstall', () => {
  it('says so when no service was installed', async () => {
    const s = stubService({ installed: false, running: null, detail: 'not installed' });
    const r = await run(['uninstall'], { service: s.service });
    expect(r.out).toBe('No service was installed.\n');
    expect(r.exitCode).toBeUndefined();
    expect(s.calls).toEqual(['uninstall']);
  });

  it('says the service was removed when one was installed', async () => {
    const s = stubService({ installed: true, running: true, detail: 'running (launchd)' });
    const r = await run(['uninstall'], { service: s.service });
    expect(r.out).toBe('Service removed.\n');
    expect(s.calls).toEqual(['uninstall']);
  });
});

describe('daemon status', () => {
  const NOW = new Date('2026-10-20T10:00:30Z');
  const running: ServiceStatus = { installed: true, running: true, detail: 'running (launchd)' };
  const stopped: ServiceStatus = { installed: true, running: false, detail: 'installed, inactive' };
  let store: string;
  beforeEach(async () => { store = path.join(tmp, 'store'); await mkdir(store, { recursive: true }); });

  /** Deps whose wacli is the fake, reading the store directory above. */
  const deps = (status: ServiceStatus, env: Record<string, string> = {}): DaemonCommandDeps => ({
    service: stubService(status).service,
    makeRunner: (account) => createRunner({ bin: FAKE_WACLI, account, baseEnv: fakeEnv({ FAKE_WACLI_STORE_DIR: store, ...env }) }),
    now: () => NOW,
  });

  it('prints the service line, then last activity from the heartbeat and the last sync', async () => {
    await writeFile(path.join(store, 'HEARTBEAT'), '2026-10-20T10:00:00Z\n');
    const r = await run(['status'], deps(running));
    expect(r.out).toBe('running (launchd)\nlast activity: 30s ago\nlast sync: 2026-10-19T10:06:00.000Z\n');
    expect(r.exitCode).toBeUndefined();
  });

  it('says none when there is no heartbeat and unknown when there is no last sync', async () => {
    const dir = await fixturesWith({ 'doctor.json': '{"success":true,"data":{"store_dir":"__STORE_DIR__","lock_held":false,"authenticated":true,"session_revoked":false,"connected":false,"connection_state":"disconnected","fts_enabled":true,"store":{"messages":0,"chats":0}},"error":null}\n' });
    try {
      const r = await run(['status'], deps(running, { FAKE_WACLI_FIXTURES: dir }));
      expect(r.out).toBe('running (launchd)\nlast activity: none\nlast sync: unknown\n');
    } finally {
      await removeTmp(dir);
    }
  });

  it('keeps the exit code: 1 when the service is not running, however much wacli reports', async () => {
    await writeFile(path.join(store, 'HEARTBEAT'), '2026-10-20T09:00:30Z\n');
    const r = await run(['status'], deps(stopped));
    expect(r.out).toBe('installed, inactive\nlast activity: 1h ago\nlast sync: 2026-10-19T10:06:00.000Z\n');
    expect(r.exitCode).toBe(1);
  });

  it('prints the service state only when wacli cannot be reached or the store cannot be read', async () => {
    const unreadable: Array<Record<string, string>> = [
      { FAKE_WACLI_FAIL: '*|1|something odd' },
      { FAKE_WACLI_FAIL: 'doctor|1|not authenticated; run `wacli auth`' },
      { FAKE_WACLI_VERSION: '0.21.0' },
    ];
    for (const env of unreadable) {
      const r = await run(['status'], deps(running, env));
      expect({ env, out: r.out, exitCode: r.exitCode }).toEqual({ env, out: 'running (launchd)\n', exitCode: undefined });
    }
    const missing: DaemonCommandDeps = { ...deps(stopped), makeRunner: () => createRunner({ bin: path.join(tmp, 'no-such-wacli'), baseEnv: fakeEnv() }) };
    const r = await run(['status'], missing);
    expect(r.out).toBe('installed, inactive\n');
    expect(r.exitCode).toBe(1);
  });

  it('reads the account named in the policy', async () => {
    const log = path.join(tmp, 'argv.log');
    await mkdir(path.join(tmp, 'config'), { recursive: true });
    await writeFile(path.join(tmp, 'config', 'policy.json'), JSON.stringify({ version: 1, account: 'work', writes: { enabled: false, confirm: 'always', allow: [], groups: false, rateLimit: { perHour: 20, minGapSeconds: 5 }, fileRoots: [] }, limits: { maxResults: 50, maxQueryChars: 200, maxMessageChars: 4000 }, media: { inlineImageMaxBytes: 1500000 }, daemon: { presenceMode: 'quiet', sendSpacing: '2s-6s', staleThreshold: '2m', maxDbSize: '2GB', downloadMedia: false } }));
    await run(['status'], deps(running, { FAKE_WACLI_LOG: log }));
    const doctor = (await readArgvLog(log)).find((x) => x.key === 'doctor');
    expect(doctor!.argv.slice(0, 2)).toEqual(['--account', 'work']);
  });
});

describe('formatAge', () => {
  it('uses the largest whole unit', () => {
    expect([0, 1, 59, 60, 119, 3599, 3600, 7200, 86399, 86400, 259200].map(formatAge)).toEqual(['0s', '1s', '59s', '1m', '1m', '59m', '1h', '2h', '23h', '1d', '3d']);
  });
});
