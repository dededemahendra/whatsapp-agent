import { Command } from 'commander';
import { resolvePaths } from '../paths.js';
import { loadPolicy } from '../policy/schema.js';
import { startSupervisor } from './daemon.js';

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
  return cmd;
}
