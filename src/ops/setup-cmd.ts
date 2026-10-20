import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import { resolvePaths } from '../paths.js';
import { createRunner } from '../wacli/runner.js';
import { isGlobalInstall, serviceManagerForThisMachine, servicePathsForThisMachine } from './service.js';
import { runSetup, type SetupIO } from './setup.js';

function realIo(): SetupIO {
  return {
    async ask(question) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
        return answer === 'y' || answer === 'yes';
      } finally {
        rl.close();
      }
    },
    print: (text) => process.stdout.write(text + '\n'),
    which: (bin) => new Promise((resolve) => execFile('which', [bin], (err, stdout) => resolve(err ? null : (stdout.trim().split('\n')[0] ?? null)))),
    run: (cmd, args) => new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'inherit' });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    }),
    exists: (file) => access(file).then(() => true, () => false),
  };
}

export function setupCommand(): Command {
  return new Command('setup')
    .description('Install wacli if needed, pair WhatsApp, write the default policy and set up the daemon')
    .option('--service', 'install the daemon service without asking')
    .option('--no-service', 'skip the daemon service')
    .option('--install-wacli', 'run the Homebrew install without asking')
    .action(async (opts: { service?: boolean; installWacli?: boolean }) => {
      const paths = resolvePaths();
      const ok = await runSetup({
        io: realIo(),
        paths,
        env: process.env,
        makeRunner: (bin) => createRunner({ bin, baseEnv: process.env }),
        service: serviceManagerForThisMachine(paths),
        isGlobal: isGlobalInstall(servicePathsForThisMachine(paths).cliPath),
        flags: { service: opts.service, installWacli: opts.installWacli },
      });
      if (!ok) process.exitCode = 1;
    });
}
