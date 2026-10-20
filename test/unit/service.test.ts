import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServiceManager, isGlobalInstall, launchdPlist, launchdPlistPath, servicePathsForThisMachine, systemdUnit, systemdUnitPath, type ServicePaths } from '../../src/ops/service.js';
import { followFile, tailFile } from '../../src/ops/tail.js';
import { resolvePaths } from '../../src/paths.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';
import { waitFor } from '../helpers/wait.js';

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
    expect(isGlobalInstall('/Users/u/Library/Caches/pnpm/dlx/abc123/1700000000-1/node_modules/.pnpm/whatsapp-agent@0.1.0/node_modules/whatsapp-agent/dist/cli.js', {})).toBe(false);
    expect(isGlobalInstall('/home/u/.cache/pnpm/dlx/abc123/node_modules/whatsapp-agent/dist/cli.js', {})).toBe(false);
    expect(isGlobalInstall('/private/tmp/bunx-501-whatsapp-agent@latest/node_modules/whatsapp-agent/dist/cli.js', {})).toBe(false);
    expect(isGlobalInstall('/Users/u/Library/pnpm/global/5/node_modules/whatsapp-agent/dist/cli.js', {})).toBe(true);
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
  it('renders a systemd unit with quoted words, mixed kill mode and no network ordering', () => {
    const unit = systemdUnit(sp);
    expect(unit).toContain('ExecStart="/usr/local/bin/node" "/usr/local/lib/node_modules/whatsapp-agent/dist/cli.js" "daemon" "run"');
    expect(unit).toContain('Environment="WHATSAPP_AGENT_WACLI_BIN=/opt/homebrew/bin/wacli"');
    expect(unit).toContain('Environment="WHATSAPP_AGENT_DATA_DIR=/a&b"');
    expect(unit).toContain('StandardOutput=append:/home/u/.local/share/whatsapp-agent/daemon.log');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('KillMode=mixed');
    expect(unit).not.toContain('network-online');
    expect(unit).not.toContain('After=');
    expect(systemdUnitPath('/home/u')).toBe('/home/u/.config/systemd/user/whatsapp-agent.service');
  });
  it('quotes systemd values: spaces stay inside quotes, % and the ExecStart $ are doubled, quote and backslash are escaped', () => {
    const odd: ServicePaths = {
      nodePath: '/opt/my node/bin/node', cliPath: '/opt/a$b/node_modules/whatsapp-agent/dist/cli.js', wacliBin: '/opt/homebrew/bin/wacli',
      dataDir: '/data/100% dir/whatsapp-agent', configDir: '/cfg dir', home: '/home/u', uid: 501,
      env: { WHATSAPP_AGENT_DATA_DIR: '/data/100% dir/whatsapp-agent', WHATSAPP_AGENT_CONFIG_DIR: '/cfg "q" \\dir$x' },
    };
    const unit = systemdUnit(odd);
    expect(unit).toContain('ExecStart="/opt/my node/bin/node" "/opt/a$$b/node_modules/whatsapp-agent/dist/cli.js" "daemon" "run"');
    expect(unit).toContain('Environment="WHATSAPP_AGENT_DATA_DIR=/data/100%% dir/whatsapp-agent"');
    expect(unit).toContain('Environment="WHATSAPP_AGENT_CONFIG_DIR=/cfg \\"q\\" \\\\dir$x"');
    expect(unit).toContain('StandardOutput=append:/data/100%% dir/whatsapp-agent/daemon.log');
    expect(unit).toContain('StandardError=append:/data/100%% dir/whatsapp-agent/daemon.log');
  });
  it('servicePathsForThisMachine pins the resolved config and data dirs into the service environment', () => {
    const paths = resolvePaths({ XDG_CONFIG_HOME: '/mnt/cfg', XDG_DATA_HOME: '/mnt/data' }, '/home/u');
    const sp = servicePathsForThisMachine(paths, { WHATSAPP_AGENT_WACLI_BIN: '/opt/wacli' });
    expect(sp.env).toEqual({ WHATSAPP_AGENT_CONFIG_DIR: '/mnt/cfg/whatsapp-agent', WHATSAPP_AGENT_DATA_DIR: '/mnt/data/whatsapp-agent' });
    expect(sp.wacliBin).toBe('/opt/wacli');
    expect(sp.dataDir).toBe('/mnt/data/whatsapp-agent');
  });
  it('servicePathsForThisMachine makes pinned dirs absolute, even when handed relative ones', () => {
    const paths = { ...resolvePaths({}, '/home/u'), configDir: 'rel/cfg', dataDir: 'rel/data' };
    const sp = servicePathsForThisMachine(paths, {});
    expect(sp.env).toEqual({ WHATSAPP_AGENT_CONFIG_DIR: path.resolve('rel/cfg'), WHATSAPP_AGENT_DATA_DIR: path.resolve('rel/data') });
    expect(sp.dataDir).toBe(path.resolve('rel/data'));
  });
  it('servicePathsForThisMachine carries WACLI_STORE_DIR into the service when the installer has it set', () => {
    const paths = resolvePaths({}, '/home/u');
    expect(servicePathsForThisMachine(paths, { WACLI_STORE_DIR: '/mnt/wacli-store' }).env.WACLI_STORE_DIR).toBe('/mnt/wacli-store');
    expect(servicePathsForThisMachine(paths, {}).env).not.toHaveProperty('WACLI_STORE_DIR');
    expect(servicePathsForThisMachine(paths, { WACLI_STORE_DIR: '' }).env).not.toHaveProperty('WACLI_STORE_DIR');
    expect(launchdPlist({ ...sp, env: { WACLI_STORE_DIR: '/mnt/wacli-store' } })).toContain('<key>WACLI_STORE_DIR</key><string>/mnt/wacli-store</string>');
    expect(systemdUnit({ ...sp, env: { WACLI_STORE_DIR: '/mnt/wacli-store' } })).toContain('Environment="WACLI_STORE_DIR=/mnt/wacli-store"');
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
    expect(infra.files.get(file)).toContain('Environment="WHATSAPP_AGENT_WACLI_BIN=/opt/homebrew/bin/wacli"');
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
      ['systemctl', '--user', 'restart', 'whatsapp-agent.service'],
    ]);
    expect(await m.status()).toEqual({ installed: true, running: true, detail: 'running (systemd)' });
  });

  it('fails a Linux install when the restart fails, so a re-install never claims a restart that did not happen', async () => {
    const infra = fakeInfra({ 'systemctl --user': { stdout: '', code: 0 } });
    const exec = async (cmd: string, args: string[]) => {
      infra.calls.push([cmd, ...args]);
      return args[1] === 'restart' ? { stdout: 'Failed to restart', code: 1 } : { stdout: '', code: 0 };
    };
    const m = createServiceManager({ platform: 'linux', paths: sp, exec, fs: infra.fs })!;
    await expect(m.install()).rejects.toThrow(/systemctl restart failed \(1\)/);
  });

  it('retries a failed macOS bootstrap once after 500 ms, because bootout is asynchronous', async () => {
    const infra = fakeInfra();
    const sleeps: number[] = [];
    let bootstraps = 0;
    const exec = async (cmd: string, args: string[]) => {
      infra.calls.push([cmd, ...args]);
      if (args[0] === 'bootstrap' && ++bootstraps === 1) return { stdout: 'Bootstrap failed: 5: Input/output error', code: 5 };
      return { stdout: '', code: 0 };
    };
    const m = createServiceManager({ platform: 'darwin', paths: sp, exec, fs: infra.fs, sleep: async (ms) => { sleeps.push(ms); } })!;
    const file = await m.install();
    expect(infra.calls.map((c) => c[1])).toEqual(['bootout', 'bootstrap', 'bootstrap']);
    expect(infra.calls[2]).toEqual(['launchctl', 'bootstrap', 'gui/501', file]);
    expect(sleeps).toEqual([500]);
  });

  it('does not wait when the first macOS bootstrap works, and gives up after the one retry', async () => {
    const ok = fakeInfra();
    const sleeps: number[] = [];
    await createServiceManager({ platform: 'darwin', paths: sp, exec: ok.exec, fs: ok.fs, sleep: async (ms) => { sleeps.push(ms); } })!.install();
    expect(sleeps).toEqual([]);

    const bad = fakeInfra({ 'launchctl bootstrap': { stdout: 'Input/output error', code: 5 } });
    const m = createServiceManager({ platform: 'darwin', paths: sp, exec: bad.exec, fs: bad.fs, sleep: async (ms) => { sleeps.push(ms); } })!;
    await expect(m.install()).rejects.toThrow(/launchctl bootstrap failed \(5\)/);
    expect(bad.calls.filter((c) => c[1] === 'bootstrap')).toHaveLength(2);
    expect(sleeps).toEqual([500]);
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
  it('followFile shows a log created after following started from its beginning', async () => {
    const f = path.join(tmp, 'later.log');
    const chunks: string[] = [];
    const stop = followFile(f, (c) => chunks.push(c), 10);
    try {
      await stop.ready;
      await writeFile(f, 'first line\nsecond line\n');
      await waitFor(() => chunks.join('') === 'first line\nsecond line\n', { what: 'the new log to be shown from its beginning' });
      await appendFile(f, 'third line\n');
      await waitFor(() => chunks.join('') === 'first line\nsecond line\nthird line\n', { what: 'the appended line' });
    } finally {
      stop();
    }
  });
  it('followFile prints only bytes appended after it starts, intact after multi-byte text', async () => {
    const f = path.join(tmp, 'log');
    await writeFile(f, 'old line ✓\n');
    const chunks: string[] = [];
    const stop = followFile(f, (c) => chunks.push(c), 20);
    await new Promise((r) => setTimeout(r, 60));
    await appendFile(f, 'NEWLINE-ONE\n');
    await new Promise((r) => setTimeout(r, 80));
    stop();
    expect(chunks.join('')).toBe('NEWLINE-ONE\n');
  });
});
