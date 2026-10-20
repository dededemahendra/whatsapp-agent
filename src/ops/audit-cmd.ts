import { Command } from 'commander';
import { AgentError } from '../errors.js';
import { resolvePaths } from '../paths.js';
import { readAudit, type AuditRecord } from '../policy/audit.js';
import { parsePositiveInt } from './args.js';
import { stripControls } from './text.js';

/** Names, text and paths in the log came from other people or from the agent, so control characters are removed before they reach a terminal. */
export function formatAudit(records: AuditRecord[]): string {
  if (records.length === 0) return 'No audit records.\n';
  const lines = records.map((r) => {
    const name = r.to_name ? stripControls(r.to_name) : '';
    const jid = r.to_jid === null ? null : stripControls(r.to_jid);
    // A row written before the recipient was looked up has no JID; what the agent typed stands in for it.
    const typed = r.to_input ? stripControls(r.to_input) : '';
    const who = name ? `${name} (${jid})` : (jid ?? (typed || '(unresolved)'));
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
  return parsePositiveInt(raw, '--limit');
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Date.parse rolls 31 February over to March, so the calendar date is checked on its own. */
function isRealDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Only `YYYY-MM-DD` (UTC midnight) or a full ISO 8601 timestamp with a time zone; anything else would be read in a way the person did not mean. */
export function parseSince(raw: string): Date {
  const m = DATE_ONLY.exec(raw) ?? TIMESTAMP.exec(raw);
  const d = new Date(raw);
  if (!m || Number.isNaN(d.getTime()) || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) {
    throw new AgentError('invalid_input', '--since must be YYYY-MM-DD (UTC midnight) or a full ISO 8601 timestamp such as 2026-10-01T09:30:00Z');
  }
  return d;
}

export function auditCommand(): Command {
  return new Command('audit')
    .description('Show what the agent sent or tried to send')
    .option('-n, --limit <n>', 'number of records (a positive whole number)', '50')
    .option('--since <date>', 'only records at or after this time (YYYY-MM-DD is UTC midnight, or a full ISO 8601 timestamp)')
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
