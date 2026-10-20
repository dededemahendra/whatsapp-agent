import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalJid, createResolver, looksLikePhone, pickUnique } from '../../src/wacli/resolve.js';
import { createRunner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, fixturesWith, makeTmp, readArgvLog, removeTmp } from '../helpers/fake.js';

let tmp: string;
let log: string;
beforeEach(async () => { tmp = await makeTmp(); log = path.join(tmp, 'argv.log'); });
afterEach(async () => { await removeTmp(tmp); });

function resolver(extra: Record<string, string> = {}) {
  return createResolver(createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_LOG: log, ...extra }) }));
}

describe('looksLikePhone', () => {
  it('accepts formatted numbers and rejects names', () => {
    expect(looksLikePhone('+61 400 000 001')).toBe(true);
    expect(looksLikePhone('(04) 0000-0001')).toBe(true);
    expect(looksLikePhone('Alice')).toBe(false);
    expect(looksLikePhone('12345')).toBe(false);
    expect(looksLikePhone('61+400+000+001')).toBe(false);
    expect(looksLikePhone('1234567890123456')).toBe(false);
  });
});

describe('canonicalJid', () => {
  it('strips a leading plus and a device suffix from user JIDs only', () => {
    expect(canonicalJid('61400000001:12@s.whatsapp.net')).toBe('61400000001@s.whatsapp.net');
    expect(canonicalJid('+61400000001@s.whatsapp.net')).toBe('61400000001@s.whatsapp.net');
    expect(canonicalJid('120363000000000001@g.us')).toBe('120363000000000001@g.us');
  });
});

describe('pickUnique', () => {
  const a = { jid: 'a@s.whatsapp.net', name: 'Mum', kind: 'user' as const };
  const b = { jid: 'b@g.us', name: 'Mum and Dad', kind: 'group' as const };
  it('prefers an exact case-insensitive name match', () => {
    expect(pickUnique([a, b], 'mum')).toEqual({ kind: 'one', value: a });
  });
  it('accepts a single partial match', () => {
    expect(pickUnique([b], 'dad')).toEqual({ kind: 'one', value: b });
  });
  it('reports two partial matches and no exact match as many', () => {
    expect(pickUnique([a, b], 'mu')).toEqual({ kind: 'many', candidates: [a, b] });
  });
  it('reports none', () => {
    expect(pickUnique([], 'x')).toEqual({ kind: 'none' });
  });
  it('rejects a single partial match whose name does not contain the input', () => {
    expect(pickUnique([a], 'zzz')).toEqual({ kind: 'none' });
  });
});

describe('createResolver', () => {
  it('passes a JID through and picks up its name from chats list', async () => {
    const r = await resolver().resolve('61400000001@s.whatsapp.net');
    expect(r).toEqual({ jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' });
    const [rec] = await readArgvLog(log);
    expect(rec!.argv.slice(4)).toEqual(['chats', 'list', '--query=61400000001@s.whatsapp.net', '--limit=5']);
  });

  it('resolves a phone number through contacts resolve', async () => {
    const r = await resolver().resolve('+61 400 000 001');
    expect(r).toEqual({ jid: '61400000001@s.whatsapp.net', name: 'Alice Example', kind: 'user' });
    const [rec] = await readArgvLog(log);
    expect(rec!.argv.slice(4)).toEqual(['contacts', 'resolve', '--', '61400000001']);
  });

  it('builds a JID when the phone is unknown to wacli', async () => {
    const r = await resolver({ FAKE_WACLI_EMPTY: 'contacts resolve' }).resolve('+61 400 999 999');
    expect(r).toEqual({ jid: '61400999999@s.whatsapp.net', name: null, kind: 'user' });
  });

  it('resolves an exact name', async () => {
    const r = await resolver().resolve('family');
    expect(r).toEqual({ jid: '120363000000000001@g.us', name: 'Family', kind: 'group' });
  });

  it('returns ambiguous_recipient with candidates for two partial matches and no exact match', async () => {
    await expect(resolver().resolve('a')).rejects.toMatchObject({
      code: 'ambiguous_recipient',
      details: { candidates: [expect.objectContaining({ name: 'Family' }), expect.objectContaining({ name: 'Alice' })] },
    });
  });

  it('falls back to contacts search when no chat matches', async () => {
    const r = await resolver({ FAKE_WACLI_EMPTY: 'chats list' }).resolve('Alice Example');
    expect(r).toEqual({ jid: '61400000001@s.whatsapp.net', name: 'Alice Example', kind: 'user' });
    const recs = await readArgvLog(log);
    expect(recs[0]!.argv.slice(4)).toEqual(['chats', 'list', '--query=Alice Example', '--limit=50']);
    expect(recs[1]!.argv.slice(4)).toEqual(['contacts', 'search', '--limit=50', '--', 'Alice Example']);
  });

  it('returns not_found when nothing matches', async () => {
    await expect(resolver({ FAKE_WACLI_EMPTY: 'chats list,contacts search' }).resolve('Nobody')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects empty input', async () => {
    await expect(resolver().resolve('   ')).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('canonicalises a device-suffixed JID before looking it up', async () => {
    const r = await resolver().resolve('61400000001:12@s.whatsapp.net');
    expect(r).toEqual({ jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' });
  });

  it('rejects a national-format number instead of building a JID', async () => {
    await expect(resolver().resolve('0400 000 001')).rejects.toMatchObject({ code: 'invalid_input' });
    const recs = await readArgvLog(log);
    expect(recs).toHaveLength(0);
  });

  it('treats a null list from wacli as empty', async () => {
    const dir = path.join(tmp, 'fixtures');
    await mkdir(dir);
    for (const name of ['chats_list', 'contacts_search']) {
      await writeFile(path.join(dir, `${name}.json`), '{"success":true,"data":null,"error":null}\n');
    }
    await expect(resolver({ FAKE_WACLI_FIXTURES: dir }).resolve('Nobody')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('accepts a lone chat only when its name contains the input', async () => {
    const dir = path.join(tmp, 'fixtures');
    await mkdir(dir);
    await writeFile(path.join(dir, 'chats_list.json'), '{"success":true,"data":[{"jid":"120363000000000001@g.us","kind":"group","name":"Family","last_message_ts":"2026-10-19T09:00:00Z","archived":false,"pinned":false,"muted_until":0,"unread":false,"unread_count":0}],"error":null}\n');
    const r = resolver({ FAKE_WACLI_FIXTURES: dir, FAKE_WACLI_EMPTY: 'contacts search' });
    expect(await r.resolve('fam')).toEqual({ jid: '120363000000000001@g.us', name: 'Family', kind: 'group' });
    await expect(r.resolve('zzz')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('contact matching on alias and system name', () => {
  const contact = (jid: string, name: string, alias: string, system_name: string) =>
    ({ jid: `${jid}@s.whatsapp.net`, phone: `+${jid}`, name, alias, system_name, updated_at: '2026-10-19T08:00:00Z' });

  /** Resolver whose chat lookup is empty and whose contact search answers with `rows`. */
  async function withContacts(rows: unknown[], fn: (r: ReturnType<typeof resolver>) => Promise<void>): Promise<void> {
    const dir = await fixturesWith({ 'contacts_search.json': JSON.stringify({ success: true, data: rows, error: null }) });
    try {
      await fn(resolver({ FAKE_WACLI_FIXTURES: dir, FAKE_WACLI_EMPTY: 'chats list' }));
    } finally {
      await removeTmp(dir);
    }
  }

  it('resolves a lone contact that only its alias matches, showing the display name', async () => {
    await withContacts([contact('61400000009', 'Robert Smith', 'Bobby', '')], async (r) => {
      expect(await r.resolve('bobby')).toEqual({ jid: '61400000009@s.whatsapp.net', name: 'Robert Smith', kind: 'user' });
      expect(await r.resolve('bob')).toEqual({ jid: '61400000009@s.whatsapp.net', name: 'Robert Smith', kind: 'user' });
      await expect(r.resolve('zed')).rejects.toMatchObject({ code: 'not_found' });
    });
  });

  it('resolves a lone contact that only its system name matches', async () => {
    await withContacts([contact('61400000009', 'Robert Smith', '', 'Rob S')], async (r) => {
      expect(await r.resolve('Rob S')).toEqual({ jid: '61400000009@s.whatsapp.net', name: 'Robert Smith', kind: 'user' });
    });
  });

  it('prefers the one contact that matches exactly on any of its names', async () => {
    await withContacts([contact('61400000009', 'Robert Smith', 'Bob', ''), contact('61400000010', 'Roberta Jones', '', '')], async (r) => {
      expect(await r.resolve('bob')).toEqual({ jid: '61400000009@s.whatsapp.net', name: 'Robert Smith', kind: 'user' });
    });
  });

  it('is ambiguous when an alias hit and a name hit match exactly, and labels each candidate', async () => {
    await withContacts([contact('61400000009', 'Robert Smith', 'Sam', ''), contact('61400000010', 'Sam', '', '')], async (r) => {
      await expect(r.resolve('sam')).rejects.toMatchObject({
        code: 'ambiguous_recipient',
        details: {
          candidates: [
            { jid: '61400000009@s.whatsapp.net', name: 'Robert Smith', kind: 'user', matched_on: 'alias' },
            { jid: '61400000010@s.whatsapp.net', name: 'Sam', kind: 'user', matched_on: 'name' },
          ],
        },
      });
    });
  });

  it('labels partial matches by the field that contains the input', async () => {
    await withContacts([contact('61400000009', 'Robert Smith', 'Sammy', ''), contact('61400000010', 'Samantha', '', ''), contact('61400000011', 'Pat', '', 'Sam P')], async (r) => {
      const err = await r.resolve('sam').catch((e: unknown) => e) as { details: { candidates: unknown[] } };
      expect(err.details.candidates).toEqual([
        { jid: '61400000009@s.whatsapp.net', name: 'Robert Smith', kind: 'user', matched_on: 'alias' },
        { jid: '61400000010@s.whatsapp.net', name: 'Samantha', kind: 'user', matched_on: 'name' },
        { jid: '61400000011@s.whatsapp.net', name: 'Pat', kind: 'user', matched_on: 'system_name' },
      ]);
    });
  });

  it('leaves chat candidates unlabelled', async () => {
    await expect(resolver().resolve('a')).rejects.toMatchObject({
      details: { candidates: [expect.not.objectContaining({ matched_on: expect.anything() }), expect.not.objectContaining({ matched_on: expect.anything() })] },
    });
  });
});

describe('name lookups see 50 rows', () => {
  const chat = (n: number, name: string) =>
    ({ jid: `1203630000000${String(n).padStart(5, '0')}@g.us`, kind: 'group', name, last_message_ts: '2026-10-19T09:00:00Z', archived: false, pinned: false, muted_until: 0, unread: false, unread_count: 0 });
  const contact = (n: number, name: string) =>
    ({ jid: `614000${String(n).padStart(5, '0')}@s.whatsapp.net`, phone: `+614000${String(n).padStart(5, '0')}`, name, alias: '', system_name: '', updated_at: '2026-10-19T08:00:00Z' });
  const envelope = (rows: unknown[]) => JSON.stringify({ success: true, data: rows, error: null });

  async function withFixtures(files: Record<string, string>, fn: (r: ReturnType<typeof resolver>) => Promise<void>, extra: Record<string, string> = {}): Promise<void> {
    const dir = await fixturesWith(files);
    try {
      await fn(resolver({ FAKE_WACLI_FIXTURES: dir, ...extra }));
    } finally {
      await removeTmp(dir);
    }
  }

  it('asks for 50 rows from both the chat query and the contact search', async () => {
    await expect(resolver({ FAKE_WACLI_EMPTY: 'chats list,contacts search' }).resolve('Nobody')).rejects.toMatchObject({ code: 'not_found' });
    const recs = await readArgvLog(log);
    expect(recs.map((r) => r.argv.slice(4))).toEqual([
      ['chats', 'list', '--query=Nobody', '--limit=50'],
      ['contacts', 'search', '--limit=50', '--', 'Nobody'],
    ]);
  });

  it('is ambiguous when two chats are named exactly the same', async () => {
    await withFixtures({ 'chats_list.json': envelope([chat(1, 'Mum'), chat(2, 'Mum'), chat(3, 'Mum and Dad')]) }, async (r) => {
      await expect(r.resolve('mum')).rejects.toMatchObject({
        code: 'ambiguous_recipient',
        details: { candidates: [expect.objectContaining({ name: 'Mum' }), expect.objectContaining({ name: 'Mum' }), expect.objectContaining({ name: 'Mum and Dad' })] },
      });
    });
  });

  it('finds an exact chat match in row 11 of a 50-row list', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => chat(i + 1, i === 10 ? 'Zed' : `Zed ${i + 1}`));
    await withFixtures({ 'chats_list.json': envelope(rows) }, async (r) => {
      expect(await r.resolve('zed')).toEqual({ jid: rows[10]!.jid, name: 'Zed', kind: 'group' });
    });
  });

  it('finds an exact contact match in row 11 of a 50-row list', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => contact(i + 1, i === 10 ? 'Zed' : `Zed ${i + 1}`));
    await withFixtures({ 'contacts_search.json': envelope(rows) }, async (r) => {
      expect(await r.resolve('zed')).toEqual({ jid: rows[10]!.jid, name: 'Zed', kind: 'user' });
    }, { FAKE_WACLI_EMPTY: 'chats list' });
  });

  it('keeps only the first 10 candidates in the ambiguous_recipient payload', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => chat(i + 1, `Zed ${i + 1}`));
    await withFixtures({ 'chats_list.json': envelope(rows) }, async (r) => {
      const err = await r.resolve('zed').catch((e: unknown) => e) as { code: string; details: { candidates: Array<{ name: string }> } };
      expect(err.code).toBe('ambiguous_recipient');
      expect(err.details.candidates.map((c) => c.name)).toEqual(rows.slice(0, 10).map((c) => c.name));
    });
  });
});
