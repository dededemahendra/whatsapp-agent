import { Command } from 'commander';
import { runMcpServer } from './mcp/stdio.js';
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

// Later tasks append: doctorCommand(), policyCommand(), auditCommand(), daemonCommand(), setupCommand()

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`whatsapp-agent: ${message}\n`);
  process.exit(1);
});
