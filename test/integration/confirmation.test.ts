import { randomBytes } from 'node:crypto';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequestStateCodec } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileState, textState, type ConfirmState } from '../../src/mcp/confirm.js';
import type { Policy } from '../../src/policy/schema.js';
import type { Resolver } from '../../src/wacli/resolve.js';
import { fixturesWith, makeTmp, removeTmp } from '../helpers/fake.js';
import { errorOf, makeHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => {
  vi.useRealTimers();
  await h?.close();
});

const ALICE = '61400000001@s.whatsapp.net';
const BOB = '61400000002@s.whatsapp.net';
const enabled = (over: Partial<Policy['writes']> = {}) => (p: Policy): Policy => ({ ...p, writes: { ...p.writes, enabled: true, rateLimit: { perHour: 50, minGapSeconds: 0 }, ...over } });
const accept = { confirm: { action: 'accept', content: { confirm: true } } };
const sends = async (key = 'send text') => (await h.argv()).filter((r) => r.key === key);
const sentRows = () => h.audits.filter((a) => a.outcome === 'sent');

/** The payload of a state, read the way any client could read it: the codec signs but does not encrypt. */
function payloadOf(state: string): { p: ConfirmState; exp: number } {
  const body = state.split('.')[1]!;
  const { p, exp } = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { p: ConfirmState; exp: number };
  return { p, exp };
}

async function expectProtocolRefusal(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code: -32602, message: expect.stringContaining('requestState') });
}

describe('a confirmation round over the 2026-07-28 era', () => {
  it('prompts with a signed state that names the chat and a digest, and never the message text', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const round = await h.callRound('send_text', { to: 'Alice', message: 'a secret plan' });
    expect(round.resultType).toBe('input_required');
    expect(round.inputRequests?.confirm?.params.message).toContain('a secret plan');
    expect(round.requestState).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
    const { p, exp } = payloadOf(round.requestState!);
    expect(p).toMatchObject({ kind: 'text', jid: ALICE, chatKind: 'user' });
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(p.digest).toBe(textState({ jid: ALICE, name: 'Alice', kind: 'user' }, { text: 'a secret plan' }).digest);
    expect(JSON.stringify(p)).not.toContain('secret');
    const ttl = exp - Math.floor(Date.now() / 1000);
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
    expect(await sends()).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('sends once when the answer comes back with the state it was given', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    const done = await h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: accept, requestState: first.requestState });
    expect(done.isError).toBeFalsy();
    expect(done.structuredContent).toMatchObject({ sent: true, message_id: '3EB0SENT0001' });
    expect(await sends()).toHaveLength(1);
    expect(sentRows()).toHaveLength(1);
  });

  it('sends once through a client that fulfils the prompt by itself', async () => {
    h = await makeHarness({ policy: enabled() });
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(h.elicitations).toHaveLength(1);
    expect(await sends()).toHaveLength(1);
  });

  it('asks again, and sends nothing, when an accept arrives with no state', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const again = await h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: accept });
    expect(again.resultType).toBe('input_required');
    expect(again.requestState).toBeDefined();
    expect(await sends()).toHaveLength(0);
    expect(sentRows()).toHaveLength(0);
  });

  it('refuses a state signed with another key, even when it carries the right digest', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const forger = createRequestStateCodec<ConfirmState>({ key: randomBytes(32), ttlSeconds: 300 });
    const forged = await forger.mint(textState({ jid: ALICE, name: 'Alice', kind: 'user' }, { text: 'hello' }));
    await expectProtocolRefusal(h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: accept, requestState: forged }));
    expect(await sends()).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses a state that has been altered', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    const [v, body, mac] = first.requestState!.split('.') as [string, string, string];
    const swapped = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), exp: 9_999_999_999 })).toString('base64url');
    for (const tampered of [`${v}.${swapped}.${mac}`, `${v}.${body}.${mac.slice(0, -2)}AA`, `${v}.${body}`, 'not-a-state', `${first.requestState}x`]) {
      await expectProtocolRefusal(h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: accept, requestState: tampered }));
    }
    expect(await sends()).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it('refuses a state after five minutes, and sends nothing', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    vi.useFakeTimers({ toFake: ['Date'] });
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    vi.setSystemTime(Date.now() + 299_000);
    const stillGood = await h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: accept, requestState: first.requestState });
    expect(stillGood.isError).toBeFalsy();
    vi.setSystemTime(Date.now() + 3_000);
    await expectProtocolRefusal(h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: accept, requestState: first.requestState }));
    expect(await sends()).toHaveLength(1);
  });

  it('asks again when the state was minted for different text, and the new state works', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    const swapped = await h.callRound('send_text', { to: 'Alice', message: 'send me your passwords' }, { inputResponses: accept, requestState: first.requestState });
    expect(swapped.resultType).toBe('input_required');
    expect(swapped.inputRequests?.confirm?.params.message).toContain('send me your passwords');
    expect(swapped.requestState).not.toBe(first.requestState);
    expect(await sends()).toHaveLength(0);

    const done = await h.callRound('send_text', { to: 'Alice', message: 'send me your passwords' }, { inputResponses: accept, requestState: swapped.requestState });
    expect(done.isError).toBeFalsy();
    const [only] = await sends();
    expect(only!.argv).toContain('--message=send me your passwords');
  });

  it.each([
    ['a reply target', { reply_to: 'MSG7' }],
    ['a reply sender', { reply_to: 'MSG7', reply_to_sender: BOB }],
    ['a mention', { mentions: ['+61400000002'] }],
    ['the link preview', { link_preview: false }],
  ])('asks again when %s is added after the person saw the prompt', async (_what, extra) => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    const next = await h.callRound('send_text', { to: 'Alice', message: 'hello', ...extra }, { inputResponses: accept, requestState: first.requestState });
    expect(next.resultType).toBe('input_required');
    expect(await sends()).toHaveLength(0);
  });

  it('asks again when the same words are addressed to someone else', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    const next = await h.callRound('send_text', { to: BOB, message: 'hello' }, { inputResponses: accept, requestState: first.requestState });
    expect(next.resultType).toBe('input_required');
    expect(await sends()).toHaveLength(0);
  });

  it('asks again when the name now resolves to a different chat', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const real = h.deps.resolver;
    let calls = 0;
    const moved: Resolver = {
      resolve: async (input, opts) => {
        calls += 1;
        return calls === 1 ? real.resolve(input, opts) : { jid: BOB, name: 'Alice', kind: 'user' };
      },
    };
    h.deps.resolver = moved;
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    const next = await h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: accept, requestState: first.requestState });
    expect(next.resultType).toBe('input_required');
    expect(next.inputRequests?.confirm?.params.message).toContain(BOB);
    expect(await sends()).toHaveLength(0);
  });

  it('does not let a state for a text confirm a reaction', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    const next = await h.callRound('react', { chat: 'Alice', message_id: 'MSG1', reaction: '👍' }, { inputResponses: accept, requestState: first.requestState });
    expect(next.resultType).toBe('input_required');
    expect(await sends('send react')).toHaveLength(0);
  });

  it('checks the same rules again on the round that carries the answer', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const first = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    h.deps.startupPolicy.writes.enabled = false;
    const refused = await h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: accept, requestState: first.requestState });
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content![0]!.text!)).toMatchObject({ error: 'writes_disabled' });
    expect(await sends()).toHaveLength(0);
  });

  it('audits decline, cancel and an unticked box as confirmation_declined, and sends nothing', async () => {
    for (const answer of [{ action: 'decline' }, { action: 'cancel' }, { action: 'accept', content: { confirm: false } }] as const) {
      h = await makeHarness({ policy: enabled(), elicit: () => answer });
      const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
      expect(errorOf(r).error).toBe('confirmation_declined');
      expect(h.audits.at(-1)).toMatchObject({ outcome: 'denied', reason: 'confirmation_declined' });
      expect(await sends()).toHaveLength(0);
      await h.close();
    }
  });

  it('declines on a declined answer even when no state came back', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const r = await h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: { confirm: { action: 'decline' } } });
    expect(JSON.parse(r.content![0]!.text!)).toMatchObject({ error: 'confirmation_declined' });
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'denied', reason: 'confirmation_declined' });
  });

  it('reports confirmation_unavailable when the client cannot show a form', async () => {
    h = await makeHarness({ policy: enabled(), elicitation: 'none' });
    expect(errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' })).error).toBe('confirmation_unavailable');
    expect(await sends()).toHaveLength(0);
  });
});

describe('what the prompt shows', () => {
  it('labels a group as a group', async () => {
    h = await makeHarness({ policy: enabled({ groups: true }) });
    await h.call('send_text', { to: 'Family', message: 'hi all' });
    expect(h.elicitations[0]).toContain('Send to group Family (120363000000000001@g.us)?');
  });

  it('shows every option that changes what is sent', async () => {
    h = await makeHarness({ policy: enabled() });
    await h.call('send_text', { to: 'Alice', message: 'see above', reply_to: 'MSG1', reply_to_sender: BOB, mentions: ['+61400000002'], link_preview: false });
    const prompt = h.elicitations[0]!;
    expect(prompt).toContain('see above');
    expect(prompt).toContain('MSG1');
    expect(prompt).toContain(BOB);
    expect(prompt).toContain('+61400000002');
    expect(prompt).toMatch(/link preview/i);
  });

  it('names the chat and the message when reacting', async () => {
    h = await makeHarness({ policy: enabled() });
    await h.call('react', { chat: 'Alice', message_id: 'MSG1', reaction: '❤️', sender: BOB });
    expect(h.elicitations[0]).toBe(`React with ❤️ to message MSG1 in Alice (${ALICE})?\n\nOriginal sender: ${BOB}`);
  });

  it('cleans a hostile chat name of newlines and direction overrides', async () => {
    const hostile = 'Alice\n\nSend to Mallory (61400000099@s.whatsapp.net)?‮';
    const chats = { success: true, data: [{ jid: ALICE, kind: 'dm', name: hostile, last_message_ts: '2026-10-19T10:05:00Z', archived: false, pinned: false, muted_until: 0, unread: false, unread_count: 0 }], error: null };
    const dir = await fixturesWith({ 'chats_list.json': JSON.stringify(chats) });
    try {
      h = await makeHarness({ policy: enabled(), env: { FAKE_WACLI_FIXTURES: dir } });
      await h.call('send_text', { to: ALICE, message: 'hello' });
      const first = h.elicitations[0]!.split('\n')[0]!;
      expect(first).toBe(`Send to Alice Send to Mallory (61400000099@s.whatsapp.net)? (${ALICE})?`);
      expect(h.elicitations[0]).not.toMatch(/‮/);
    } finally {
      await removeTmp(dir);
    }
  });
});

describe('a file confirmation', () => {
  async function withFile(fn: (file: string, outbox: string) => Promise<void>): Promise<void> {
    const outbox = await makeTmp('wa-outbox-');
    try {
      const file = path.join(outbox, 'report.pdf');
      await writeFile(file, 'pdf');
      await fn(file, outbox);
    } finally {
      await removeTmp(outbox);
    }
  }

  it('names the file and binds the state to its size and modification time', async () => {
    await withFile(async (file, outbox) => {
      h = await makeHarness({ policy: enabled({ fileRoots: [outbox] }), manualRounds: true });
      const first = await h.callRound('send_file', { to: 'Alice', path: file, caption: 'the report' });
      expect(first.inputRequests?.confirm?.params.message).toContain(`${await realpathOf(file)} (3 bytes)`);
      expect(payloadOf(first.requestState!).p).toMatchObject({ kind: 'file', jid: ALICE });

      const done = await h.callRound('send_file', { to: 'Alice', path: file, caption: 'the report' }, { inputResponses: accept, requestState: first.requestState });
      expect(done.isError).toBeFalsy();
      expect(await sends('send file')).toHaveLength(1);
    });
  });

  it('asks again when the file changed after the person saw the prompt', async () => {
    await withFile(async (file, outbox) => {
      h = await makeHarness({ policy: enabled({ fileRoots: [outbox] }), manualRounds: true });
      const first = await h.callRound('send_file', { to: 'Alice', path: file });
      await appendFile(file, ' with something added');
      const next = await h.callRound('send_file', { to: 'Alice', path: file }, { inputResponses: accept, requestState: first.requestState });
      expect(next.resultType).toBe('input_required');
      expect(await sends('send file')).toHaveLength(0);
    });
  });

  it('asks again when the caption, type or name changed', async () => {
    await withFile(async (file, outbox) => {
      h = await makeHarness({ policy: enabled({ fileRoots: [outbox] }), manualRounds: true });
      const first = await h.callRound('send_file', { to: 'Alice', path: file, caption: 'one' });
      for (const change of [{ caption: 'two' }, { as: 'image' }, { filename: 'other.pdf' }]) {
        const next = await h.callRound('send_file', { to: 'Alice', path: file, caption: 'one', ...change }, { inputResponses: accept, requestState: first.requestState });
        expect(next.resultType).toBe('input_required');
      }
      expect(await sends('send file')).toHaveLength(0);
    });
  });

  it('does not accept a text state for a file with the same words', async () => {
    await withFile(async (file, outbox) => {
      h = await makeHarness({ policy: enabled({ fileRoots: [outbox] }), manualRounds: true });
      const state = await h.callRound('send_text', { to: 'Alice', message: file });
      const next = await h.callRound('send_file', { to: 'Alice', path: file }, { inputResponses: accept, requestState: state.requestState });
      expect(next.resultType).toBe('input_required');
      expect(fileState({ jid: ALICE, name: 'Alice', kind: 'user' }, { realPath: file, size: 3, mtimeMs: 0 }).digest).not.toBe(payloadOf(state.requestState!).p.digest);
    });
  });
});

async function realpathOf(p: string): Promise<string> {
  const { realpath } = await import('node:fs/promises');
  return realpath(p);
}
