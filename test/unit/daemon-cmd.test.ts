import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonCommand, type DaemonCommandDeps } from '../../src/ops/daemon-cmd.js';
import type { ServiceManager, ServiceStatus } from '../../src/ops/service-types.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';

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
