import { Command } from 'commander';
import { resolvePaths } from '../paths.js';
import { readAudit, type AuditRecord } from '../policy/audit.js';

export function formatAudit(records: AuditRecord[]): string {
  if (records.length === 0) return 'No audit records.\n';
  const lines = records.map((r) => {
    const who = r.to_name ? `${r.to_name} (${r.to_jid})` : (r.to_jid ?? '(unresolved)');
    const parts = [r.ts, r.outcome.padEnd(6), r.tool, who];
    if (r.message_id) parts.push(`id=${r.message_id}`);
    if (r.reason) parts.push(r.reason);
    if (r.text) parts.push(JSON.stringify(r.text));
    if (r.file) parts.push(r.file);
    if (r.reaction) parts.push(`reaction=${r.reaction}`);
    return parts.join('  ');
  });
  return lines.join('\n') + '\n';
}

export function auditCommand(): Command {
  return new Command('audit')
    .description('Show what the agent sent or tried to send')
    .option('-n, --limit <n>', 'number of records', '50')
    .option('--since <date>', 'only records at or after this time (YYYY-MM-DD or RFC 3339)')
    .option('--tool <name>', 'filter by tool name')
    .option('--json', 'print JSON lines')
    .action(async (opts: { limit: string; since?: string; tool?: string; json?: boolean }) => {
      const records = await readAudit(resolvePaths().auditFile, {
        limit: Number(opts.limit) || 50,
        since: opts.since ? new Date(opts.since) : undefined,
        tool: opts.tool,
      });
      process.stdout.write(opts.json ? records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '') : formatAudit(records));
    });
}
