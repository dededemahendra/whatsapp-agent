import { Command } from 'commander';
import { runMcpServer } from './mcp/stdio.js';
import { auditCommand } from './ops/audit-cmd.js';
import { doctorCommand } from './ops/doctor-cmd.js';
import { policyCommand } from './ops/policy-cmd.js';
import { PKG_VERSION } from './version.js';

export const program = new Command()
  .name('whatsapp-agent')
  .description('MCP server and CLI that lets AI agents read, search and send WhatsApp through wacli, with writes off by default')
  .version(PKG_VERSION);

program
  .command('mcp')
  .description('Start the MCP server on stdio (used by agent hosts)')
  .action(async () => {
    await runMcpServer();
  });

program.addCommand(doctorCommand());
program.addCommand(policyCommand());
program.addCommand(auditCommand());

// Later tasks append: daemonCommand(), setupCommand()

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`whatsapp-agent: ${message}\n`);
  process.exit(1);
});
