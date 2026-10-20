import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createResolver, looksLikePhone, pickUnique } from '../../src/wacli/resolve.js';
import { createRunner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, makeTmp, readArgvLog, removeTmp } from '../helpers/fake.js';

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
    expect(recs[1]!.argv.slice(4)).toEqual(['contacts', 'search', '--limit=10', '--', 'Alice Example']);
  });

  it('returns not_found when nothing matches', async () => {
    await expect(resolver({ FAKE_WACLI_EMPTY: 'chats list,contacts search' }).resolve('Nobody')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects empty input', async () => {
    await expect(resolver().resolve('   ')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
