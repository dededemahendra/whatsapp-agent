import { appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, readAudit, type AuditRecord } from '../../src/policy/audit.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

const rec = (over: Partial<AuditRecord>): AuditRecord => ({
  ts: '2026-10-20T10:00:00.000Z', tool: 'send_text', to_jid: '1@s.whatsapp.net', to_name: 'Alice', kind: 'user', outcome: 'sent', ...over,
});

describe('audit log', () => {
  it('appends JSON lines with mode 0600 and reads them back in order', async () => {
    const file = path.join(tmp, 'data', 'audit.jsonl');
    await appendAudit(file, rec({ ts: '2026-10-20T10:00:00.000Z', message_id: 'A', text: 'hi' }));
    await appendAudit(file, rec({ ts: '2026-10-20T10:01:00.000Z', outcome: 'denied', reason: 'rate_limited' }));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const all = await readAudit(file);
    expect(all.map((r) => r.ts)).toEqual(['2026-10-20T10:00:00.000Z', '2026-10-20T10:01:00.000Z']);
    expect(all[0]!.text).toBe('hi');
  });

  it('filters by since and tool, applies the limit, skips bad lines', async () => {
    const file = path.join(tmp, 'audit.jsonl');
    await appendAudit(file, rec({ ts: '2026-10-20T10:00:00.000Z', tool: 'react' }));
    await appendFile(file, 'not json\n');
    await appendAudit(file, rec({ ts: '2026-10-20T11:00:00.000Z' }));
    await appendAudit(file, rec({ ts: '2026-10-20T12:00:00.000Z' }));
    expect((await readAudit(file, { since: new Date('2026-10-20T10:30:00Z') })).length).toBe(2);
    expect((await readAudit(file, { tool: 'react' })).length).toBe(1);
    expect((await readAudit(file, { limit: 1 }))[0]!.ts).toBe('2026-10-20T12:00:00.000Z');
    expect(await readAudit(path.join(tmp, 'missing.jsonl'))).toEqual([]);
  });
});
