import { appendFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAudit, auditInput, readAudit, type AuditRecord } from '../../src/policy/audit.js';
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

describe('auditInput', () => {
  it('keeps an ordinary recipient as typed', () => {
    expect(auditInput('Dave')).toBe('Dave');
    expect(auditInput("Dave's Plumbing & Gas")).toBe("Dave's Plumbing & Gas");
    expect(auditInput('+61 400 000 001')).toBe('+61 400 000 001');
    expect(auditInput('山田 太郎')).toBe('山田 太郎');
  });

  it('strips C0 and C1 control characters and DEL, without leaving a gap', () => {
    expect(auditInput('Al\nice\u0007\u001b[31m')).toBe('Alice[31m');
    expect(auditInput('a\u0000b\tc\r\nd\u007fe\u0085f\u009fg')).toBe('abcdefg');
  });

  it('cuts at 80 characters with no ellipsis, and 80 exactly is left alone', () => {
    expect(auditInput('x'.repeat(80))).toBe('x'.repeat(80));
    expect(auditInput('x'.repeat(81))).toBe('x'.repeat(80));
    expect(auditInput('y'.repeat(500))).toHaveLength(80);
  });

  it('counts characters rather than UTF-16 units, so it never cuts a pair in half', () => {
    const cut = auditInput('😀'.repeat(100));
    expect(Array.from(cut)).toHaveLength(80);
    expect(cut).toBe('😀'.repeat(80));
  });

  it('strips before it cuts, so controls do not use up the 80', () => {
    expect(auditInput(`${'\u0007'.repeat(50)}${'z'.repeat(100)}`)).toBe('z'.repeat(80));
  });

  it('travels in a row and reads back', async () => {
    const file = path.join(tmp, 'audit.jsonl');
    await appendAudit(file, rec({ to_jid: null, to_name: null, kind: null, outcome: 'denied', reason: 'writes_disabled', to_input: 'Dave' }));
    expect((await readAudit(file))[0]).toMatchObject({ to_jid: null, to_input: 'Dave' });
  });
});
