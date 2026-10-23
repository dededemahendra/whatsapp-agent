import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import { resolvePaths } from '../paths.js';
import { createRunner } from '../wacli/runner.js';
import { isGlobalInstall, serviceManagerForThisMachine, servicePathsForThisMachine } from './service.js';
import { runSetup, type SetupIO } from './setup.js';

export function realIo(input: NodeJS.ReadableStream & { isTTY?: boolean } = process.stdin, output: NodeJS.WritableStream & { isTTY?: boolean } = process.stdout): SetupIO {
  return {
    async ask(question) {
      if (!input.isTTY) {
        output.write(`${question} [y/N]\n`);
        output.write('Not a terminal, so no questions are asked. Pass --install-wacli, --service or --no-service to answer them.\n');
        return false;
      }
      const rl = readline.createInterface({ input, output });
      try {
        return await new Promise<boolean>((resolve, reject) => {
          // Ctrl+C or the end of the input leaves the cursor after the prompt; start a fresh line before whatever prints next.
          let answered = false;
          const endLine = (): void => { if (output.isTTY) output.write('\n'); };
          // Ctrl+C cancels setup. Reject before closing: closing fires 'close', which resolves false, and the first settle wins.
          rl.once('SIGINT', () => {
            answered = true;
            endLine();
            reject(new Error('Setup cancelled.'));
            rl.close();
          });
          rl.once('close', () => {
            if (!answered) endLine();
            resolve(false);
          });
          rl.question(`${question} [y/N] `).then((reply) => {
            answered = true;
            const answer = reply.trim().toLowerCase();
            resolve(answer === 'y' || answer === 'yes');
          }, reject);
        });
      } finally {
        rl.close();
      }
    },
    print: (text) => { output.write(text + '\n'); },
    which: (bin) => new Promise((resolve) => execFile('which', [bin], (err, stdout) => resolve(err ? null : (stdout.trim().split('\n')[0] ?? null)))),
    run: (cmd, args) => new Promise((resolve) => {
      const child = spawn(cmd, args, { stdio: 'inherit' });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', (err) => {
        process.stderr.write(`${cmd}: ${err.message}\n`);
        resolve(1);
      });
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
        makeRunner: (bin, account) => createRunner({ bin, account, baseEnv: process.env }),
        service: serviceManagerForThisMachine(paths),
        isGlobal: isGlobalInstall(servicePathsForThisMachine(paths).cliPath),
        flags: { service: opts.service, installWacli: opts.installWacli },
      });
      if (!ok) process.exitCode = 1;
    });
}
