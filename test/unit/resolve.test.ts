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

describe('the user part of a JID', () => {
  it('is refused unless it is 6 to 15 digits once canonicalised, and nothing is looked up', async () => {
    for (const bad of [':12@s.whatsapp.net', '+@s.whatsapp.net', 'abc@s.whatsapp.net', '12345@s.whatsapp.net', '1234567890123456@s.whatsapp.net', '6140+000001@s.whatsapp.net', '+abc:3@s.whatsapp.net']) {
      await expect(resolver().resolve(bad)).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('6 to 15 digits') });
    }
    expect(await readArgvLog(log)).toEqual([]);
  });

  it('accepts a plus or a device suffix on a good number, and leaves other JIDs untouched', async () => {
    expect((await resolver().resolve('+61400000001:9@s.whatsapp.net')).jid).toBe('61400000001@s.whatsapp.net');
    expect(await resolver().resolve('100000000000001@lid')).toEqual({ jid: '100000000000001@lid', name: null, kind: 'user' });
    expect(await resolver().resolve('abc@lid')).toEqual({ jid: 'abc@lid', name: null, kind: 'user' });
    expect((await resolver().resolve('120363000000000001@g.us')).kind).toBe('group');
  });
});

describe('resolver pins', () => {
  const envelope = (rows: unknown[]) => JSON.stringify({ success: true, data: rows, error: null });

  it('pickUnique reports two chats with the same name as many, in list order', () => {
    const first = { jid: 'a@s.whatsapp.net', name: 'Mum', kind: 'user' as const };
    const second = { jid: 'b@g.us', name: 'Mum', kind: 'group' as const };
    expect(pickUnique([first, second], 'mum')).toEqual({ kind: 'many', candidates: [first, second] });
  });

  it('sends an input that starts with dashes as --query=--help for chats and after -- for contacts', async () => {
    await expect(resolver({ FAKE_WACLI_EMPTY: 'chats list' }).resolve('--help')).rejects.toMatchObject({ code: 'not_found' });
    const recs = await readArgvLog(log);
    expect(recs.map((r) => r.argv.slice(4))).toEqual([
      ['chats', 'list', '--query=--help', '--limit=50'],
      ['contacts', 'search', '--limit=50', '--', '--help'],
    ]);
  });

  it('maps newsletter, broadcast and lid JIDs to their kinds, by suffix when wacli has no row', async () => {
    expect(await resolver().resolve('120363000000000009@newsletter')).toEqual({ jid: '120363000000000009@newsletter', name: null, kind: 'channel' });
    expect(await resolver().resolve('status@broadcast')).toEqual({ jid: 'status@broadcast', name: null, kind: 'broadcast' });
    expect(await resolver().resolve('100000000000001@lid')).toEqual({ jid: '100000000000001@lid', name: null, kind: 'user' });
  });

  it('maps them from the wacli row, with its name, when there is one', async () => {
    const row = (jid: string, kind: string, name: string) => ({ jid, kind, name, last_message_ts: '2026-10-19T09:00:00Z', archived: false, pinned: false, muted_until: 0, unread: false, unread_count: 0 });
    const dir = await fixturesWith({
      'chats_list.json': envelope([row('120363000000000009@newsletter', 'newsletter', 'News'), row('status@broadcast', 'broadcast', 'Status'), row('100000000000001@lid', 'dm', 'Lid Person')]),
    });
    try {
      const r = resolver({ FAKE_WACLI_FIXTURES: dir });
      expect(await r.resolve('120363000000000009@newsletter')).toEqual({ jid: '120363000000000009@newsletter', name: 'News', kind: 'channel' });
      expect(await r.resolve('status@broadcast')).toEqual({ jid: 'status@broadcast', name: 'Status', kind: 'broadcast' });
      expect(await r.resolve('100000000000001@lid')).toEqual({ jid: '100000000000001@lid', name: 'Lid Person', kind: 'user' });
    } finally {
      await removeTmp(dir);
    }
  });

  it('is ambiguous in the contacts branch when no chat matches and several contacts partly match', async () => {
    const contact = (n: number, name: string) => ({ jid: `614000000${n}0@s.whatsapp.net`, phone: `+614000000${n}0`, name, alias: '', system_name: '', updated_at: '2026-10-19T08:00:00Z' });
    const dir = await fixturesWith({ 'contacts_search.json': envelope([contact(1, 'Sam Jones'), contact(2, 'Samantha Lee')]) });
    try {
      await expect(resolver({ FAKE_WACLI_FIXTURES: dir, FAKE_WACLI_EMPTY: 'chats list' }).resolve('sam')).rejects.toMatchObject({
        code: 'ambiguous_recipient',
        message: expect.stringContaining('"sam" matches 2 chats or contacts'),
        details: {
          candidates: [
            { jid: '61400000010@s.whatsapp.net', name: 'Sam Jones', kind: 'user', matched_on: 'name' },
            { jid: '61400000020@s.whatsapp.net', name: 'Samantha Lee', kind: 'user', matched_on: 'name' },
          ],
        },
      });
    } finally {
      await removeTmp(dir);
    }
  });
});

describe('exact resolution for writes', () => {
  const chat = (jid: string, name: string, kind = 'dm') =>
    ({ jid, kind, name, last_message_ts: '2026-10-19T09:00:00Z', archived: false, pinned: false, muted_until: 0, unread: false, unread_count: 0 });
  const contact = (jid: string, name: string, alias = '', system_name = '') => ({ jid, phone: `+${jid.split('@')[0]}`, name, alias, system_name, updated_at: '2026-10-19T08:00:00Z' });
  const envelope = (rows: unknown[]) => JSON.stringify({ success: true, data: rows, error: null });
  const DAVE = '61400000011@s.whatsapp.net';
  const PLUMBING = '61400000012@s.whatsapp.net';
  const DAVID = '61400000013@s.whatsapp.net';
  const NOT_EXACT = 'No chat or contact is named exactly "Dave". Use the exact name or the JID.';

  async function withFixtures(files: Record<string, string>, fn: (r: ReturnType<typeof resolver>) => Promise<void>, extra: Record<string, string> = {}): Promise<void> {
    const dir = await fixturesWith(files);
    try {
      await fn(resolver({ FAKE_WACLI_FIXTURES: dir, ...extra }));
    } finally {
      await removeTmp(dir);
    }
  }
  const plumbingOnly = { 'chats_list.json': envelope([chat(PLUMBING, "Dave's Plumbing")]), 'contacts_search.json': envelope([contact(DAVID, 'David Smith')]) };

  it('keeps the lone-partial rule for reads and refuses it for writes, offering the one candidate', async () => {
    await withFixtures(plumbingOnly, async (r) => {
      expect(await r.resolve('Dave')).toEqual({ jid: PLUMBING, name: "Dave's Plumbing", kind: 'user' });
      expect(await r.resolve('Dave', { exact: false })).toEqual({ jid: PLUMBING, name: "Dave's Plumbing", kind: 'user' });
      await expect(r.resolve('Dave', { exact: true })).rejects.toMatchObject({
        code: 'ambiguous_recipient',
        message: NOT_EXACT,
        details: { candidates: [{ jid: PLUMBING, name: "Dave's Plumbing", kind: 'user' }] },
      });
    });
  });

  it('accepts an exact match whatever the case, spacing or Unicode form', async () => {
    const decomposed = 'Café Dave';
    await withFixtures({ 'chats_list.json': envelope([chat(PLUMBING, "Dave's Plumbing"), chat(DAVE, '  dAVE  '), chat(DAVID, decomposed)]) }, async (r) => {
      expect(await r.resolve('Dave', { exact: true })).toMatchObject({ jid: DAVE });
      expect(await r.resolve('  dave ', { exact: true })).toMatchObject({ jid: DAVE });
      expect(await r.resolve('Café Dave', { exact: true })).toMatchObject({ jid: DAVID });
    });
  });

  it('accepts an exact alias or system name, and names the field on a lone partial', async () => {
    await withFixtures({ 'contacts_search.json': envelope([contact(DAVE, 'Robert Smith', 'Dave', '')]) }, async (r) => {
      expect(await r.resolve('Dave', { exact: true })).toEqual({ jid: DAVE, name: 'Robert Smith', kind: 'user' });
    }, { FAKE_WACLI_EMPTY: 'chats list' });
    await withFixtures({ 'contacts_search.json': envelope([contact(DAVE, 'Robert Smith', '', 'Dave')]) }, async (r) => {
      expect(await r.resolve('dave', { exact: true })).toEqual({ jid: DAVE, name: 'Robert Smith', kind: 'user' });
    }, { FAKE_WACLI_EMPTY: 'chats list' });
    await withFixtures({ 'contacts_search.json': envelope([contact(DAVE, 'Robert Smith', 'Davey', '')]) }, async (r) => {
      await expect(r.resolve('Dave', { exact: true })).rejects.toMatchObject({
        code: 'ambiguous_recipient',
        message: NOT_EXACT,
        details: { candidates: [{ jid: DAVE, name: 'Robert Smith', kind: 'user', matched_on: 'alias' }] },
      });
      expect(await r.resolve('Dave')).toMatchObject({ jid: DAVE });
    }, { FAKE_WACLI_EMPTY: 'chats list' });
  });

  it('prefers an exact contact over a lone partial chat', async () => {
    await withFixtures({ 'chats_list.json': envelope([chat(PLUMBING, "Dave's Plumbing")]), 'contacts_search.json': envelope([contact(DAVE, 'Dave')]) }, async (r) => {
      expect(await r.resolve('Dave', { exact: true })).toEqual({ jid: DAVE, name: 'Dave', kind: 'user' });
      expect(await r.resolve('Dave')).toEqual({ jid: PLUMBING, name: "Dave's Plumbing", kind: 'user' });
    });
  });

  it('offers a lone partial chat and a lone partial contact together, without repeating one person', async () => {
    await withFixtures({ 'chats_list.json': envelope([chat(PLUMBING, "Dave's Plumbing")]), 'contacts_search.json': envelope([contact(DAVID, 'Davey Jones')]) }, async (r) => {
      await expect(r.resolve('Dave', { exact: true })).rejects.toMatchObject({
        code: 'ambiguous_recipient',
        message: NOT_EXACT,
        details: { candidates: [expect.objectContaining({ jid: PLUMBING }), expect.objectContaining({ jid: DAVID })] },
      });
    });
    await withFixtures({ 'chats_list.json': envelope([chat(PLUMBING, "Dave's Plumbing")]), 'contacts_search.json': envelope([contact(PLUMBING, "Dave's Plumbing")]) }, async (r) => {
      await expect(r.resolve('Dave', { exact: true })).rejects.toMatchObject({ details: { candidates: [expect.objectContaining({ jid: PLUMBING })] } });
    });
  });

  it('still reports several partial matches as an ordinary ambiguity, and nothing as not_found', async () => {
    await withFixtures({ 'chats_list.json': envelope([chat(PLUMBING, "Dave's Plumbing"), chat(DAVID, 'Davey')]) }, async (r) => {
      await expect(r.resolve('Dave', { exact: true })).rejects.toMatchObject({ code: 'ambiguous_recipient', message: expect.stringContaining('"Dave" matches 2 chats or contacts') });
    });
    await expect(resolver({ FAKE_WACLI_EMPTY: 'chats list,contacts search' }).resolve('Dave', { exact: true })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('leaves phone numbers and JIDs exactly as they are', async () => {
    const r = resolver();
    expect(await r.resolve('+61 400 000 001', { exact: true })).toEqual(await r.resolve('+61 400 000 001'));
    expect(await r.resolve('61400000001@s.whatsapp.net', { exact: true })).toEqual({ jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' });
    await expect(r.resolve('0400 000 001', { exact: true })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('pickUnique takes the same option', () => {
    const only = { jid: 'a@s.whatsapp.net', name: "Dave's Plumbing", kind: 'user' as const };
    expect(pickUnique([only], 'dave')).toEqual({ kind: 'one', value: only });
    expect(pickUnique([only], 'dave', { exact: true })).toEqual({ kind: 'partial', candidate: only });
    expect(pickUnique([only], 'zzz', { exact: true })).toEqual({ kind: 'none' });
    expect(pickUnique([only], "dave's plumbing", { exact: true })).toEqual({ kind: 'one', value: only });
  });
});

describe('exact matches come first among the candidates', () => {
  const chat = (n: number, name: string) =>
    ({ jid: `1203630000000${String(n).padStart(5, '0')}@g.us`, kind: 'group', name, last_message_ts: '2026-10-19T09:00:00Z', archived: false, pinned: false, muted_until: 0, unread: false, unread_count: 0 });
  const contact = (n: number, name: string, alias = '', system_name = '') =>
    ({ jid: `614000${String(n).padStart(5, '0')}@s.whatsapp.net`, phone: `+614000${String(n).padStart(5, '0')}`, name, alias, system_name, updated_at: '2026-10-19T08:00:00Z' });
  const envelope = (rows: unknown[]) => JSON.stringify({ success: true, data: rows, error: null });

  async function candidatesFor(files: Record<string, string>, input: string, extra: Record<string, string> = {}, opts: { exact?: boolean } = {}): Promise<Array<{ jid: string; name: string | null; matched_on?: string }>> {
    const dir = await fixturesWith(files);
    try {
      const err = await resolver({ FAKE_WACLI_FIXTURES: dir, ...extra }).resolve(input, opts).catch((e: unknown) => e) as { code: string; details: { candidates: Array<{ jid: string; name: string | null }> } };
      expect(err.code).toBe('ambiguous_recipient');
      return err.details.candidates;
    } finally {
      await removeTmp(dir);
    }
  }

  it('lists two exact chats ahead of twelve partial ones listed before them, and then caps at 10', async () => {
    const rows = [...Array.from({ length: 12 }, (_, i) => chat(i + 1, `Zed ${i + 1}`)), chat(101, 'Zed'), chat(102, 'zed')];
    const candidates = await candidatesFor({ 'chats_list.json': envelope(rows) }, 'zed');
    expect(candidates).toHaveLength(10);
    expect(candidates.slice(0, 2).map((c) => c.jid)).toEqual([rows[12]!.jid, rows[13]!.jid]);
    expect(candidates.slice(2).map((c) => c.name)).toEqual(['Zed 1', 'Zed 2', 'Zed 3', 'Zed 4', 'Zed 5', 'Zed 6', 'Zed 7', 'Zed 8']);
  });

  it('keeps lookup order inside each group', async () => {
    const rows = [chat(1, 'Zed One'), chat(2, 'Zed'), chat(3, 'Zed Two'), chat(4, 'ZED'), chat(5, 'Zed Three')];
    const candidates = await candidatesFor({ 'chats_list.json': envelope(rows) }, 'zed');
    expect(candidates.map((c) => c.name)).toEqual(['Zed', 'ZED', 'Zed One', 'Zed Two', 'Zed Three']);
  });

  it('counts an exact alias or system name as exact, and keeps the label', async () => {
    const rows = [contact(1, 'Zedd One'), contact(2, 'Zedd Two'), contact(3, 'Robert', 'Zed'), contact(4, 'Maria', '', 'ZED'), contact(5, 'Zedd Three')];
    const candidates = await candidatesFor({ 'contacts_search.json': envelope(rows) }, 'zed', { FAKE_WACLI_EMPTY: 'chats list' });
    expect(candidates.map((c) => [c.name, c.matched_on])).toEqual([['Robert', 'alias'], ['Maria', 'system_name'], ['Zedd One', 'name'], ['Zedd Two', 'name'], ['Zedd Three', 'name']]);
  });

  it('puts the exact ones first when a write asks for an exact name too', async () => {
    const rows = [chat(1, 'Zed One'), chat(2, 'Zed Two'), chat(3, 'Zed'), chat(4, 'Zed')];
    const candidates = await candidatesFor({ 'chats_list.json': envelope(rows) }, 'zed', {}, { exact: true });
    expect(candidates.map((c) => c.name)).toEqual(['Zed', 'Zed', 'Zed One', 'Zed Two']);
  });

  it('leaves the order alone when nothing matches exactly', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => chat(i + 1, `Zed ${i + 1}`));
    const candidates = await candidatesFor({ 'chats_list.json': envelope(rows) }, 'zed');
    expect(candidates.map((c) => c.name)).toEqual(rows.slice(0, 10).map((c) => c.name));
  });

  it('pickUnique orders the same way', () => {
    const mk = (jid: string, name: string) => ({ jid, name, kind: 'user' as const });
    const rows = [mk('a@s.whatsapp.net', 'Zed A'), mk('b@s.whatsapp.net', 'Zed B'), mk('c@s.whatsapp.net', 'Zed'), mk('d@s.whatsapp.net', 'zed ')];
    const r = pickUnique(rows, 'zed');
    expect(r.kind).toBe('many');
    if (r.kind === 'many') expect(r.candidates.map((c) => c.jid)).toEqual(['c@s.whatsapp.net', 'd@s.whatsapp.net', 'a@s.whatsapp.net', 'b@s.whatsapp.net']);
  });
});
