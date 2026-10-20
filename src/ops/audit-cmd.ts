import { Command } from 'commander';
import { AgentError } from '../errors.js';
import { resolvePaths } from '../paths.js';
import { readAudit, type AuditRecord } from '../policy/audit.js';
import { stripControls } from './text.js';

/** Names, text and paths in the log came from other people or from the agent, so control characters are removed before they reach a terminal. */
export function formatAudit(records: AuditRecord[]): string {
  if (records.length === 0) return 'No audit records.\n';
  const lines = records.map((r) => {
    const name = r.to_name ? stripControls(r.to_name) : '';
    const jid = r.to_jid === null ? null : stripControls(r.to_jid);
    const who = name ? `${name} (${jid})` : (jid ?? '(unresolved)');
    const parts = [stripControls(r.ts), stripControls(r.outcome).padEnd(6), stripControls(r.tool), who];
    if (r.message_id) parts.push(`id=${stripControls(r.message_id)}`);
    if (r.reason) parts.push(stripControls(r.reason));
    if (r.text) parts.push(JSON.stringify(stripControls(r.text)));
    if (r.file) parts.push(stripControls(r.file));
    if (r.reaction) parts.push(`reaction=${stripControls(r.reaction)}`);
    return parts.join('  ');
  });
  return lines.join('\n') + '\n';
}

export function parseLimit(raw: string): number {
  if (!/^[1-9]\d*$/.test(raw)) throw new AgentError('invalid_input', '--limit must be a positive whole number');
  return Number(raw);
}

export function parseSince(raw: string): Date {
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new AgentError('invalid_input', '--since must be YYYY-MM-DD (UTC midnight) or an RFC 3339 timestamp');
  return d;
}

export function auditCommand(): Command {
  return new Command('audit')
    .description('Show what the agent sent or tried to send')
    .option('-n, --limit <n>', 'number of records (a positive whole number)', '50')
    .option('--since <date>', 'only records at or after this time (YYYY-MM-DD is UTC midnight, or RFC 3339)')
    .option('--tool <name>', 'filter by tool name')
    .option('--json', 'print JSON lines')
    .action(async (opts: { limit: string; since?: string; tool?: string; json?: boolean }) => {
      const records = await readAudit(resolvePaths().auditFile, {
        limit: parseLimit(opts.limit),
        since: opts.since ? parseSince(opts.since) : undefined,
        tool: opts.tool,
      });
      process.stdout.write(opts.json ? records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '') : formatAudit(records));
    });
}
