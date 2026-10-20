import { Command } from 'commander';
import { AgentError } from '../errors.js';
import { ensureDirs, resolvePaths } from '../paths.js';
import { loadPolicy } from '../policy/schema.js';
import { startSupervisor } from './daemon.js';
import { isGlobalInstall, serviceManagerForThisMachine, servicePathsForThisMachine } from './service.js';
import { followFile, tailFile } from './tail.js';

export function daemonCommand(): Command {
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
    const manager = serviceManagerForThisMachine(paths);
    if (!manager) throw new AgentError('invalid_input', 'Service installation is supported on macOS and Linux only. Run `whatsapp-agent daemon run` under your own supervisor.');
    const file = await manager.install();
    process.stdout.write(`Installed ${file}\n${(await manager.status()).detail}\nLogs: ${paths.daemonLog}\n`);
  });

  cmd.command('uninstall').description('Remove the login service').action(async () => {
    const paths = resolvePaths();
    const manager = serviceManagerForThisMachine(paths);
    if (!manager) throw new AgentError('invalid_input', 'No service support on this platform.');
    await manager.uninstall();
    process.stdout.write('Service removed.\n');
  });

  cmd.command('status').description('Show whether the service is installed and running').action(async () => {
    const paths = resolvePaths();
    const manager = serviceManagerForThisMachine(paths);
    const s = manager ? await manager.status() : { installed: false, running: null, detail: 'not supported on this platform' };
    process.stdout.write(`${s.detail}\n`);
    if (manager && !s.running) process.exitCode = 1;
  });

  cmd.command('logs').description('Show the daemon log').option('-n, --lines <n>', 'lines to show', '100').option('-f, --follow', 'keep printing new lines').action(async (opts: { lines: string; follow?: boolean }) => {
    const paths = resolvePaths();
    process.stdout.write(await tailFile(paths.daemonLog, Number(opts.lines) || 100));
    if (opts.follow) {
      const stop = followFile(paths.daemonLog, (chunk) => process.stdout.write(chunk));
      await new Promise<void>((resolve) => { process.on('SIGINT', () => { stop(); resolve(); }); });
    }
  });

  return cmd;
}
