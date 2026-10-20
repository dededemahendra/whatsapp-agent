import { Command } from 'commander';
import { buildDeps } from '../mcp/stdio.js';
import { collectDoctor, formatDoctor } from './doctor.js';
import { serviceManagerForThisMachine } from './service.js';

export function doctorCommand(): Command {
  return new Command('doctor')
    .description('Check wacli, pairing, the daemon and the policy')
    .option('--json', 'print JSON')
    .action(async (opts: { json?: boolean }) => {
      const { deps, paths, policy } = await buildDeps();
      const report = await collectDoctor({ runner: deps.runner, policy, paths, service: serviceManagerForThisMachine(paths), now: () => new Date() });
      process.stdout.write(opts.json ? JSON.stringify(report, null, 2) + '\n' : formatDoctor(report));
      if (report.problems.length > 0) process.exitCode = 1;
    });
}
