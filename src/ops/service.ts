import { execFile, type ExecFileException } from 'node:child_process';
import { access, mkdir, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentError } from '../errors.js';
import type { Paths } from '../paths.js';
import type { ServiceManager, ServiceStatus } from './service-types.js';

export type Platform = 'darwin' | 'linux' | 'other';
export const LAUNCHD_LABEL = 'com.whatsapp-agent.daemon';
export const SYSTEMD_UNIT = 'whatsapp-agent.service';

export interface ServicePaths {
  nodePath: string; cliPath: string; wacliBin: string; dataDir: string; configDir: string; home: string; uid: number;
  env: Record<string, string>;
}
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; code: number }>;
export interface ServiceFs {
  writeFile(file: string, text: string): Promise<void>;
  unlink(file: string): Promise<void>;
  exists(file: string): Promise<boolean>;
}

export function platformOf(p: NodeJS.Platform = process.platform): Platform {
  return p === 'darwin' ? 'darwin' : p === 'linux' ? 'linux' : 'other';
}

export function isGlobalInstall(cliPath: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WHATSAPP_AGENT_ALLOW_LOCAL_SERVICE === '1') return true;
  const p = cliPath.split(path.sep).join('/');
  if (/\/(_npx|dlx-[^/]+|\.pnpm-store|\.cache)\//.test(p)) return false;
  return /\/node_modules\/whatsapp-agent\//.test(p);
}

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const launchdPlistPath = (home: string): string => path.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
export const systemdUnitPath = (home: string): string => path.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT);

export function launchdPlist(p: ServicePaths): string {
  const log = path.join(p.dataDir, 'daemon.log');
  const envEntries: Record<string, string> = {
    WHATSAPP_AGENT_WACLI_BIN: p.wacliBin,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    HOME: p.home,
    ...p.env,
  };
  const envXml = Object.entries(envEntries).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(p.nodePath)}</string>`,
    `    <string>${xml(p.cliPath)}</string>`,
    '    <string>daemon</string>',
    '    <string>run</string>',
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key><false/>',
    '  </dict>',
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    envXml,
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function systemdUnit(p: ServicePaths): string {
  const log = path.join(p.dataDir, 'daemon.log');
  const envLines = Object.entries({ WHATSAPP_AGENT_WACLI_BIN: p.wacliBin, ...p.env }).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  return [
    '[Unit]',
    'Description=whatsapp-agent sync daemon',
    'After=network-online.target',
    '',
    '[Service]',
    `ExecStart=${p.nodePath} ${p.cliPath} daemon run`,
    'Restart=on-failure',
    'RestartSec=5',
    envLines,
    `StandardOutput=append:${log}`,
    `StandardError=append:${log}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

async function resolveWacliBin(p: ServicePaths, exec: ExecFn): Promise<ServicePaths> {
  if (path.isAbsolute(p.wacliBin)) return p;
  const r = await exec('which', [p.wacliBin]);
  const found = r.stdout.trim().split('\n')[0] ?? '';
  if (r.code !== 0 || found === '') throw new AgentError('wacli_not_installed', `wacli was not found on PATH. Install it with: brew install openclaw/tap/wacli`);
  return { ...p, wacliBin: found };
}

export function createServiceManager(opts: { platform: Platform; paths: ServicePaths; exec: ExecFn; fs: ServiceFs }): ServiceManager | null {
  const { platform, exec, fs } = opts;
  const notInstalled: ServiceStatus = { installed: false, running: null, detail: 'not installed' };

  if (platform === 'darwin') {
    const file = launchdPlistPath(opts.paths.home);
    const target = `gui/${opts.paths.uid}/${LAUNCHD_LABEL}`;
    return {
      async install() {
        const p = await resolveWacliBin(opts.paths, exec);
        await fs.writeFile(file, launchdPlist(p));
        await exec('launchctl', ['bootout', target]);
        const r = await exec('launchctl', ['bootstrap', `gui/${p.uid}`, file]);
        if (r.code !== 0) throw new AgentError('wacli_error', `launchctl bootstrap failed (${r.code}): ${r.stdout.trim()}`);
        return file;
      },
      async uninstall() {
        await exec('launchctl', ['bootout', target]);
        if (await fs.exists(file)) await fs.unlink(file);
      },
      async status() {
        if (!(await fs.exists(file))) return notInstalled;
        const r = await exec('launchctl', ['print', target]);
        if (r.code !== 0) return { installed: true, running: false, detail: 'installed, not loaded' };
        const running = /state = running/.test(r.stdout);
        return { installed: true, running, detail: running ? 'running (launchd)' : 'loaded, not running' };
      },
    };
  }

  if (platform === 'linux') {
    const file = systemdUnitPath(opts.paths.home);
    return {
      async install() {
        const p = await resolveWacliBin(opts.paths, exec);
        await fs.writeFile(file, systemdUnit(p));
        await exec('systemctl', ['--user', 'daemon-reload']);
        const r = await exec('systemctl', ['--user', 'enable', '--now', SYSTEMD_UNIT]);
        if (r.code !== 0) throw new AgentError('wacli_error', `systemctl enable failed (${r.code}): ${r.stdout.trim()}`);
        return file;
      },
      async uninstall() {
        await exec('systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT]);
        if (await fs.exists(file)) await fs.unlink(file);
        await exec('systemctl', ['--user', 'daemon-reload']);
      },
      async status() {
        if (!(await fs.exists(file))) return notInstalled;
        const r = await exec('systemctl', ['--user', 'is-active', SYSTEMD_UNIT]);
        const state = r.stdout.trim();
        const running = state === 'active';
        return { installed: true, running, detail: running ? 'running (systemd)' : `installed, ${state || 'inactive'}` };
      },
    };
  }

  return null;
}

export const realExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000 }, (err, stdout, stderr) => {
      const e = err as ExecFileException | null;
      resolve({ stdout: `${stdout}${stderr}`, code: e ? (typeof e.code === 'number' ? e.code : 1) : 0 });
    });
  });

export const realFs: ServiceFs = {
  async writeFile(file, text) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text, { mode: 0o644 });
  },
  unlink: (file) => unlink(file),
  async exists(file) {
    try { await access(file); return true; } catch { return false; }
  },
};

export function servicePathsForThisMachine(paths: Paths, env: NodeJS.ProcessEnv = process.env): ServicePaths {
  const extra: Record<string, string> = {};
  if (env.WHATSAPP_AGENT_CONFIG_DIR) extra.WHATSAPP_AGENT_CONFIG_DIR = env.WHATSAPP_AGENT_CONFIG_DIR;
  if (env.WHATSAPP_AGENT_DATA_DIR) extra.WHATSAPP_AGENT_DATA_DIR = env.WHATSAPP_AGENT_DATA_DIR;
  return {
    nodePath: process.execPath,
    cliPath: fileURLToPath(new URL('../cli.js', import.meta.url)),
    wacliBin: env.WHATSAPP_AGENT_WACLI_BIN || 'wacli',
    dataDir: paths.dataDir,
    configDir: paths.configDir,
    home: os.homedir(),
    uid: typeof process.getuid === 'function' ? process.getuid() : 0,
    env: extra,
  };
}

export function serviceManagerForThisMachine(paths: Paths): ServiceManager | null {
  return createServiceManager({ platform: platformOf(), paths: servicePathsForThisMachine(paths), exec: realExec, fs: realFs });
}
