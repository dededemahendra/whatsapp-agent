import { appendFile, chmod, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensurePrivateDir } from '../paths.js';

export interface AuditRecord {
  ts: string;
  tool: string;
  to_jid: string | null;
  to_name: string | null;
  kind: string | null;
  outcome: 'sent' | 'denied' | 'failed';
  reason?: string;
  message_id?: string;
  text?: string;
  file?: string;
  reaction?: string;
  client?: string;
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
