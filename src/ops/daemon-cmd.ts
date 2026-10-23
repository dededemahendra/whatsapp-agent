import { Command } from 'commander';
import { AgentError } from '../errors.js';
import { ensureDirs, resolvePaths, type Paths } from '../paths.js';
import { loadPolicy } from '../policy/schema.js';
import { createRunner, type Runner } from '../wacli/runner.js';
import { getStatus } from '../wacli/status.js';
import { parsePositiveInt } from './args.js';
import { startSupervisor } from './daemon.js';
import { isGlobalInstall, serviceManagerForThisMachine, servicePathsForThisMachine } from './service.js';
import type { ServiceManager } from './service-types.js';
import { followFile, tailFile } from './tail.js';
import { formatAge } from './text.js';

export interface DaemonCommandDeps {
  /** Builds the service manager; tests pass a stub so no launchctl or systemctl runs. */
  service?: (paths: Paths) => ServiceManager | null;
  /** Builds the runner `status` reads wacli through; tests pass one over the fake. */
  makeRunner?: (account: string | null) => Runner;
  now?: () => Date;
}

const realRunner = (account: string | null): Runner =>
  createRunner({ bin: process.env.WHATSAPP_AGENT_WACLI_BIN || 'wacli', account, baseEnv: process.env });

export function daemonCommand(deps: DaemonCommandDeps = {}): Command {
  const serviceFor = deps.service ?? serviceManagerForThisMachine;
  const makeRunner = deps.makeRunner ?? realRunner;
  const now = deps.now ?? ((): Date => new Date());

  /** What wacli's store says about recent activity, or null when the store cannot be read through wacli. */
  async function storeActivity(paths: Paths): Promise<{ activity: string; sync: string } | null> {
    try {
      const account = await loadPolicy(paths.policyFile).then((p) => p.account, () => null);
      const status = await getStatus(makeRunner(account), now());
      if (status.store_dir === null) return null;
      return {
        activity: status.heartbeat_age_seconds === null ? 'none' : `${formatAge(status.heartbeat_age_seconds)} ago`,
        sync: status.last_sync_at ?? 'unknown',
      };
    } catch {
      return null;
    }
  }

  const cmd = new Command('daemon').description('Keep the WhatsApp mirror in sync in the background');

  cmd.command('run').description('Run the sync supervisor in the foreground (service installers call this)').action(async () => {
    const paths = resolvePaths();
    const policy = await loadPolicy(paths.policyFile);
    const handle = startSupervisor({
      bin: process.env.WHATSAPP_AGENT_WACLI_BIN || 'wacli',
      account: policy.account,
      daemon: policy.daemon,
      log: (line) => process.stdout.write(line + '\n'),
    });
    const onSignal = () => { void handle.stop(); };
    process.on('SIGTERM', onSignal);
    process.on('SIGINT', onSignal);
    await handle.done;
    process.exit(0);
  });

  cmd.command('install').description('Install the sync daemon as a login service (launchd or systemd)').action(async () => {
    const paths = resolvePaths();
    await ensureDirs(paths);
    const sp = servicePathsForThisMachine(paths);
    if (!isGlobalInstall(sp.cliPath)) {
      throw new AgentError('invalid_input', 'daemon install needs a global install so the service has a stable path. Run: npm i -g whatsapp-agent, then: whatsapp-agent daemon install');
    }
    const manager = serviceFor(paths);
    if (!manager) throw new AgentError('invalid_input', 'Service installation is supported on macOS and Linux only. Run `whatsapp-agent daemon run` under your own supervisor.');
    const file = await manager.install();
    process.stdout.write(`Installed ${file}\n${(await manager.status()).detail}\nLogs: ${paths.daemonLog}\n`);
  });

  cmd.command('uninstall').description('Remove the login service').action(async () => {
    const paths = resolvePaths();
    const manager = serviceFor(paths);
    if (!manager) throw new AgentError('invalid_input', 'No service support on this platform.');
    const before = await manager.status();
    await manager.uninstall();
    process.stdout.write(before.installed ? 'Service removed.\n' : 'No service was installed.\n');
  });

  cmd.command('status').description('Show whether the service is installed and running, and when wacli last did anything').action(async () => {
    const paths = resolvePaths();
    const manager = serviceFor(paths);
    const s = manager ? await manager.status() : { installed: false, running: null, detail: 'not supported on this platform' };
    process.stdout.write(`${s.detail}\n`);
    const store = await storeActivity(paths);
    if (store) process.stdout.write(`last activity: ${store.activity}\nlast sync: ${store.sync}\n`);
    if (!manager || !s.running) process.exitCode = 1;
  });

  cmd.command('logs').description('Show the daemon log').option('-n, --lines <n>', 'lines to show (a positive whole number)', '100').option('-f, --follow', 'keep printing new lines').action(async (opts: { lines: string; follow?: boolean }) => {
    const lines = parsePositiveInt(opts.lines, '--lines');
    const paths = resolvePaths();
    const text = await tailFile(paths.daemonLog, lines);
    process.stdout.write(text ?? `No log yet at ${paths.daemonLog}.\n`);
    if (opts.follow) {
      const stop = followFile(paths.daemonLog, (chunk) => process.stdout.write(chunk));
      await new Promise<void>((resolve) => { process.on('SIGINT', () => { stop(); resolve(); }); });
    }
  });

  return cmd;
}
