import { appendFile, chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir } from '../paths.js';

export interface AuditRecord {
  ts: string;
  tool: string;
  to_jid: string | null;
  to_name: string | null;
  /** What the agent called the recipient, on a row written before a JID is known (see auditInput). Never on a row that has a JID. */
  to_input?: string;
  kind: string | null;
  /** `attempted` is written just before wacli is called and is followed by `sent` or `failed`; one with nothing after it means the outcome is unknown. */
  outcome: 'attempted' | 'sent' | 'denied' | 'failed';
  reason?: string;
  /** True on a failed row whose send may still have been delivered. The reason says so too. */
  uncertain?: boolean;
  message_id?: string;
  text?: string;
  file?: string;
  reaction?: string;
  client?: string;
}

/** The recipient exactly as the agent typed it, for a row written before there is a JID: control characters removed, 80 characters at most. */
export function auditInput(raw: string): string {
  return Array.from(raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')).slice(0, 80).join('');
}

export async function appendAudit(file: string, rec: AuditRecord): Promise<void> {
  await ensurePrivateDir(path.dirname(file));
  await appendFile(file, JSON.stringify(rec) + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
}

export async function readAudit(file: string, opts: { limit?: number; since?: Date; tool?: string } = {}): Promise<AuditRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  const records: AuditRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const r = JSON.parse(line) as AuditRecord;
      if (typeof r.ts === 'string' && typeof r.tool === 'string') records.push(r);
    } catch {
      // skip malformed line
    }
  }
  const filtered = records.filter((r) =>
    (opts.since === undefined || new Date(r.ts).getTime() >= opts.since.getTime())
    && (opts.tool === undefined || r.tool === opts.tool));
  const limit = opts.limit ?? 50;
  return filtered.slice(Math.max(0, filtered.length - limit));
}
