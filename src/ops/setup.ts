import path from 'node:path';
import { AgentError } from '../errors.js';
import { ensureDirs, type Paths } from '../paths.js';
import { DEFAULT_POLICY, loadPolicy, savePolicy, type Policy } from '../policy/schema.js';
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
  makeRunner: (bin: string, account?: string) => Runner;
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

function configuredBin(o: SetupOptions): string {
  return o.env.WHATSAPP_AGENT_WACLI_BIN || 'wacli';
}

async function findWacli(o: SetupOptions): Promise<string | null> {
  const bin = configuredBin(o);
  if (path.isAbsolute(bin)) return (await o.io.exists(bin)) ? bin : null;
  return o.io.which(bin);
}

type Paired = { paired: true } | { paired: false; fatal: boolean };

async function checkPaired(runner: Runner, io: SetupIO): Promise<Paired> {
  try {
    const status = await runner.read<WacliAuthStatus>(['auth', 'status']);
    return status.authenticated ? { paired: true } : { paired: false, fatal: false };
  } catch (e) {
    if (e instanceof AgentError) {
      if (e.code === 'not_authenticated' || e.code === 'session_logged_out') return { paired: false, fatal: false };
      io.print(e.message);
      const fatal = e.code === 'store_locked' || e.code === 'timeout' || e.code === 'wacli_not_installed';
      return { paired: false, fatal };
    }
    io.print(String(e));
    return { paired: false, fatal: false };
  }
}

export async function runSetup(o: SetupOptions): Promise<boolean> {
  const { io } = o;

  let bin = await findWacli(o);
  if (!bin) {
    const configured = configuredBin(o);
    if (path.isAbsolute(configured)) {
      io.print(`WHATSAPP_AGENT_WACLI_BIN is set to ${configured} but nothing is there.`);
      return false;
    }
    io.print(INSTALL_LINES);
    const install = o.flags.installWacli ?? (await io.ask('Install wacli with Homebrew now?'));
    if (install) {
      const code = await io.run('brew', ['install', 'openclaw/tap/wacli']);
      if (code !== 0) io.print(`Homebrew install exited with code ${code}.`);
      bin = await findWacli(o);
    }
    if (!bin) {
      io.print('Install wacli, then run whatsapp-agent setup again.');
      return false;
    }
  }

  const policyPresent = await io.exists(o.paths.policyFile);
  let policy: Policy = DEFAULT_POLICY;
  if (policyPresent) {
    try {
      policy = await loadPolicy(o.paths.policyFile);
    } catch (e) {
      io.print(e instanceof AgentError ? e.message : String(e));
      return false;
    }
  }

  const runner = o.makeRunner(bin, policy.account ?? undefined);
  const version = await runner.version();
  if (version === null) {
    io.print(`Could not read the wacli version from ${bin}. Run \`${bin} version\` to check that it works.`);
    return false;
  }
  if (!meetsMinimum(version)) {
    io.print(`wacli ${version} is older than the minimum ${MIN_WACLI_VERSION}. Upgrade with: brew upgrade wacli`);
    return false;
  }
  io.print(`wacli ${version} found at ${bin}`);

  const first = await checkPaired(runner, io);
  if (!first.paired) {
    if (first.fatal) return false;
    io.print('WhatsApp is not paired on this machine. On your phone open WhatsApp, Settings, Linked devices, Link a device, then scan the code that appears below. The first sync runs after pairing and can take a few minutes.');
    await io.run(bin, [...(policy.account ? ['--account', policy.account] : []), 'auth']);
    if (!(await checkPaired(runner, io)).paired) {
      io.print('Pairing did not complete. Run whatsapp-agent setup again when you are ready.');
      return false;
    }
  }
  io.print('WhatsApp is paired.');

  await ensureDirs(o.paths);
  if (!policyPresent) {
    await savePolicy(o.paths.policyFile, DEFAULT_POLICY);
    io.print(`Wrote default policy (writes off) to ${o.paths.policyFile}`);
  } else {
    io.print(`Keeping existing policy at ${o.paths.policyFile}`);
  }

  let ready = true;
  if (!o.service) {
    io.print('Background sync: no service support on this platform. Run `whatsapp-agent daemon run` under your own supervisor so reads stay fresh.');
  } else if (!o.isGlobal) {
    io.print('Background sync: install the package globally so the daemon has a stable path, then install the service:\n  npm i -g whatsapp-agent\n  whatsapp-agent daemon install');
  } else {
    const wantService = o.flags.service ?? (await io.ask('Install the sync daemon as a login service? Without it reads go stale and each send opens a fresh session.'));
    if (wantService) {
      try {
        const file = await o.service.install();
        io.print(`Installed the sync daemon service at ${file}. Logs: ${o.paths.daemonLog}`);
      } catch (e) {
        io.print(`Could not install the service: ${e instanceof Error ? e.message : String(e)}`);
        io.print('Install it later with: whatsapp-agent daemon install');
        ready = false;
      }
    } else {
      io.print('Skipped the service. Install it later with: whatsapp-agent daemon install');
    }
  }

  io.print('');
  io.print(mcpConfigHelp());
  io.print('');
  io.print(BAN_NOTICE);
  io.print('');
  io.print(policy.writes.enabled
    ? 'Write tools are on in your existing policy. Turn them off with: whatsapp-agent policy disable'
    : 'Write tools are off. When you are ready: whatsapp-agent policy enable');
  return ready;
}
