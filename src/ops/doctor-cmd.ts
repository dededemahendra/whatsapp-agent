import { Command } from 'commander';
import { resolvePaths, type Paths } from '../paths.js';
import { loadPolicy } from '../policy/schema.js';
import { createRunner } from '../wacli/runner.js';
import { collectDoctor, formatDoctor } from './doctor.js';
import { serviceManagerForThisMachine } from './service.js';
import type { ServiceManager } from './service-types.js';

export interface DoctorCommandDeps {
  service?: (paths: Paths) => ServiceManager | null;
}

/** Doctor must work when the policy is corrupt and must not create anything, so it does not go through buildDeps. */
export function doctorCommand(deps: DoctorCommandDeps = {}): Command {
  return new Command('doctor')
    .description('Check wacli, pairing, the daemon and the policy')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const paths = resolvePaths();
      const account = await loadPolicy(paths.policyFile).then((p) => p.account, () => null);
      const runner = createRunner({ bin: process.env.WHATSAPP_AGENT_WACLI_BIN || 'wacli', account, baseEnv: process.env });
      const service = (deps.service ?? serviceManagerForThisMachine)(paths);
      const report = await collectDoctor({ runner, policyFile: paths.policyFile, paths, service, now: () => new Date() });
      process.stdout.write(opts.json ? JSON.stringify(report, null, 2) + '\n' : formatDoctor(report));
      if (report.problems.length > 0) process.exitCode = 1;
    });
}
