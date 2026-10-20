import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServiceManager, isGlobalInstall, launchdPlist, launchdPlistPath, systemdUnit, systemdUnitPath, type ServicePaths } from '../../src/ops/service.js';
import { tailFile } from '../../src/ops/tail.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';

const sp: ServicePaths = {
  nodePath: '/usr/local/bin/node', cliPath: '/usr/local/lib/node_modules/whatsapp-agent/dist/cli.js', wacliBin: '/opt/homebrew/bin/wacli',
  dataDir: '/home/u/.local/share/whatsapp-agent', configDir: '/home/u/.config/whatsapp-agent', home: '/home/u', uid: 501, env: { WHATSAPP_AGENT_DATA_DIR: '/a&b' },
};

describe('isGlobalInstall', () => {
  it('accepts a global node_modules path and rejects npx, dlx and repo checkouts', () => {
    expect(isGlobalInstall('/usr/local/lib/node_modules/whatsapp-agent/dist/cli.js', {})).toBe(true);
    expect(isGlobalInstall('/Users/u/.npm/_npx/abc123/node_modules/whatsapp-agent/dist/cli.js', {})).toBe(false);
    expect(isGlobalInstall('/Users/u/.cache/dlx-9f8e/node_modules/whatsapp-agent/dist/cli.js', {})).toBe(false);
    expect(isGlobalInstall('/Users/u/Developer/whatsapp-agent/dist/cli.js', {})).toBe(false);
    expect(isGlobalInstall('/Users/u/Developer/whatsapp-agent/dist/cli.js', { WHATSAPP_AGENT_ALLOW_LOCAL_SERVICE: '1' })).toBe(true);
  });
});

describe('templates', () => {
  it('renders a launchd plist with escaped values', () => {
    const plist = launchdPlist(sp);
    expect(plist).toContain('<string>com.whatsapp-agent.daemon</string>');
    expect(plist).toContain('<string>/usr/local/bin/node</string>');
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<key>WHATSAPP_AGENT_WACLI_BIN</key><string>/opt/homebrew/bin/wacli</string>');
    expect(plist).toContain('<string>/a&amp;b</string>');
    expect(plist).toContain('<key>StandardOutPath</key><string>/home/u/.local/share/whatsapp-agent/daemon.log</string>');
    expect(plist).toContain('<key>SuccessfulExit</key><false/>');
    expect(plist).not.toContain('<key>KeepAlive</key><true/>');
    expect(launchdPlistPath('/home/u')).toBe('/home/u/Library/LaunchAgents/com.whatsapp-agent.daemon.plist');
  });
  it('renders a systemd unit', () => {
    const unit = systemdUnit(sp);
    expect(unit).toContain('ExecStart=/usr/local/bin/node /usr/local/lib/node_modules/whatsapp-agent/dist/cli.js daemon run');
    expect(unit).toContain('Environment=WHATSAPP_AGENT_WACLI_BIN=/opt/homebrew/bin/wacli');
    expect(unit).toContain('Restart=on-failure');
    expect(systemdUnitPath('/home/u')).toBe('/home/u/.config/systemd/user/whatsapp-agent.service');
  });
});

function fakeInfra(responses: Record<string, { stdout: string; code: number }> = {}) {
  const calls: string[][] = [];
  const files = new Map<string, string>();
  const exec = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return responses[`${cmd} ${args[0]}`] ?? { stdout: '', code: 0 }; };
  const fs = {
    writeFile: async (f: string, t: string) => { files.set(f, t); },
    unlink: async (f: string) => { files.delete(f); },
    exists: async (f: string) => files.has(f),
  };
  return { calls, files, exec, fs };
}

describe('createServiceManager', () => {
  it('installs, reports and uninstalls on macOS', async () => {
    const infra = fakeInfra({ 'launchctl print': { stdout: 'state = running\n', code: 0 } });
    const m = createServiceManager({ platform: 'darwin', paths: sp, exec: infra.exec, fs: infra.fs })!;
    expect(await m.status()).toEqual({ installed: false, running: null, detail: 'not installed' });
    const file = await m.install();
    expect(file).toBe(launchdPlistPath('/home/u'));
    expect(infra.files.get(file)).toContain('com.whatsapp-agent.daemon');
    expect(infra.calls).toEqual([
      ['launchctl', 'bootout', 'gui/501/com.whatsapp-agent.daemon'],
      ['launchctl', 'bootstrap', 'gui/501', file],
    ]);
    expect(await m.status()).toEqual({ installed: true, running: true, detail: 'running (launchd)' });
    await m.uninstall();
    expect(infra.files.has(file)).toBe(false);
  });

  it('resolves a bare wacli name with which before writing the service', async () => {
    const infra = fakeInfra({ 'which wacli': { stdout: '/opt/homebrew/bin/wacli\n', code: 0 } });
    const m = createServiceManager({ platform: 'linux', paths: { ...sp, wacliBin: 'wacli' }, exec: infra.exec, fs: infra.fs })!;
    const file = await m.install();
    expect(infra.files.get(file)).toContain('Environment=WHATSAPP_AGENT_WACLI_BIN=/opt/homebrew/bin/wacli');
    expect(infra.calls[0]).toEqual(['which', 'wacli']);
  });

  it('installs and reports on Linux', async () => {
    const infra = fakeInfra({ 'systemctl --user': { stdout: 'active\n', code: 0 } });
    const m = createServiceManager({ platform: 'linux', paths: sp, exec: infra.exec, fs: infra.fs })!;
    const file = await m.install();
    expect(file).toBe(systemdUnitPath('/home/u'));
    expect(infra.calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'whatsapp-agent.service'],
    ]);
    expect(await m.status()).toEqual({ installed: true, running: true, detail: 'running (systemd)' });
  });

  it('fails install when the service command fails', async () => {
    const infra = fakeInfra({ 'launchctl bootstrap': { stdout: 'Input/output error', code: 5 } });
    const m = createServiceManager({ platform: 'darwin', paths: sp, exec: infra.exec, fs: infra.fs })!;
    await expect(m.install()).rejects.toThrow(/launchctl bootstrap failed/);
  });

  it('returns null on unsupported platforms', () => {
    expect(createServiceManager({ platform: 'other', paths: sp, exec: fakeInfra().exec, fs: fakeInfra().fs })).toBeNull();
  });
});

describe('tailFile', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await makeTmp(); });
  afterEach(async () => { await removeTmp(tmp); });
  it('returns the last n lines and tolerates a missing file', async () => {
    const f = path.join(tmp, 'log');
    await writeFile(f, 'a\nb\nc\nd\n');
    expect(await tailFile(f, 2)).toBe('c\nd\n');
    expect(await tailFile(f, 10)).toBe('a\nb\nc\nd\n');
    expect(await tailFile(path.join(tmp, 'missing'), 3)).toBe('');
  });
});
