import path from 'node:path';
import { ensureDirs, type Paths } from '../paths.js';
import { DEFAULT_POLICY, savePolicy } from '../policy/schema.js';
import type { Runner } from '../wacli/runner.js';
import type { WacliAuthStatus } from '../wacli/shape.js';
import { meetsMinimum, MIN_WACLI_VERSION } from '../version.js';
import { mcpConfigHelp } from './mcp-config.js';
import type { ServiceManager } from './service-types.js';

export interface SetupIO {
  ask(question: string): Promise<boolean>;
  print(text: string): void;
  which(bin: string): Promise<string | null>;
  run(cmd: string, args: string[]): Promise<number>;
  exists(file: string): Promise<boolean>;
}

export interface SetupOptions {
  io: SetupIO;
  paths: Paths;
  env: NodeJS.ProcessEnv;
  makeRunner: (bin: string) => Runner;
  service: ServiceManager | null;
  isGlobal: boolean;
  flags: { service?: boolean; installWacli?: boolean };
}

export const BAN_NOTICE = [
  'Please read before you turn writes on.',
  'whatsapp-agent and wacli use the WhatsApp Web protocol through an unofficial client. WhatsApp\'s terms prohibit that, and accounts have been warned or banned even at low volume.',
  'Use a number you can afford to lose. Never use this for bulk, cold or marketing messages. Keep the rate limit on.',
].join('\n');

const INSTALL_LINES = [
  'wacli is not installed. Install it with one of:',
  '  brew install openclaw/tap/wacli',
  '  CGO_ENABLED=1 CGO_CFLAGS="-Wno-error=missing-braces" go install -tags sqlite_fts5 github.com/openclaw/wacli/cmd/wacli@latest',
].join('\n');

async function findWacli(o: SetupOptions): Promise<string | null> {
  const bin = o.env.WHATSAPP_AGENT_WACLI_BIN || 'wacli';
  if (path.isAbsolute(bin)) return (await o.io.exists(bin)) ? bin : null;
  return o.io.which(bin);
}

export async function runSetup(o: SetupOptions): Promise<boolean> {
  const { io } = o;

  let bin = await findWacli(o);
  if (!bin) {
    io.print(INSTALL_LINES);
    const install = o.flags.installWacli ?? (await io.ask('Install wacli with Homebrew now?'));
    if (install) {
      await io.run('brew', ['install', 'openclaw/tap/wacli']);
      bin = await findWacli(o);
    }
    if (!bin) {
      io.print('Install wacli, then run whatsapp-agent setup again.');
      return false;
    }
  }

  const runner = o.makeRunner(bin);
  const version = await runner.version();
  if (!meetsMinimum(version)) {
    io.print(`wacli ${version ?? '(unknown version)'} is older than the minimum ${MIN_WACLI_VERSION}. Upgrade with: brew upgrade wacli`);
    return false;
  }
  io.print(`wacli ${version} found at ${bin}`);

  const status = await runner.read<WacliAuthStatus>(['auth', 'status']).catch(() => ({ authenticated: false }));
  if (!status.authenticated) {
    io.print('WhatsApp is not paired on this machine. On your phone open WhatsApp, Settings, Linked devices, Link a device, then scan the code that appears below. The first sync runs after pairing and can take a few minutes.');
    await io.run(bin, ['auth']);
    const after = await runner.read<WacliAuthStatus>(['auth', 'status']).catch(() => ({ authenticated: false }));
    if (!after.authenticated) {
      io.print('Pairing did not complete. Run whatsapp-agent setup again when you are ready.');
      return false;
    }
  }
  io.print('WhatsApp is paired.');

  await ensureDirs(o.paths);
  if (!(await io.exists(o.paths.policyFile))) {
    await savePolicy(o.paths.policyFile, DEFAULT_POLICY);
    io.print(`Wrote default policy (writes off) to ${o.paths.policyFile}`);
  } else {
    io.print(`Keeping existing policy at ${o.paths.policyFile}`);
  }

  if (!o.service) {
    io.print('Background sync: no service support on this platform. Run `whatsapp-agent daemon run` under your own supervisor so reads stay fresh.');
  } else if (!o.isGlobal) {
    io.print('Background sync: install the package globally so the daemon has a stable path, then install the service:\n  npm i -g whatsapp-agent\n  whatsapp-agent daemon install');
  } else {
    const wantService = o.flags.service ?? (await io.ask('Install the sync daemon as a login service? Without it reads go stale and each send opens a fresh session.'));
    if (wantService) {
      const file = await o.service.install();
      io.print(`Installed the sync daemon service at ${file}. Logs: ${o.paths.daemonLog}`);
    } else {
      io.print('Skipped the service. Install it later with: whatsapp-agent daemon install');
    }
  }

  io.print('');
  io.print(mcpConfigHelp());
  io.print('');
  io.print(BAN_NOTICE);
  io.print('');
  io.print('Write tools are off. When you are ready: whatsapp-agent policy enable');
  return true;
}
