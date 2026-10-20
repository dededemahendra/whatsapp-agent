import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentError } from '../../src/errors.js';
import type { Policy } from '../../src/policy/schema.js';
import { createRunner, SEND_UNCERTAIN } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, fixturesWith, makeTmp, removeTmp } from '../helpers/fake.js';
import { errorOf, makeHarness, stubWrite, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => { await h?.close(); });

const enabled = (over: Partial<Policy['writes']> = {}) => (p: Policy): Policy => ({ ...p, writes: { ...p.writes, enabled: true, ...over } });
const sendArgv = async () => (await h.argv()).filter((r) => r.key === 'send text');

describe('send_text', () => {
  it('is denied while writes are disabled and nothing reaches wacli, not even a name lookup', async () => {
    h = await makeHarness();
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ error: 'writes_disabled', message: expect.stringContaining('policy enable') });
    expect(await h.argv()).toEqual([]);
    expect(h.audits).toEqual([expect.objectContaining({ tool: 'send_text', outcome: 'denied', reason: 'writes_disabled', to_jid: null, to_name: null, kind: null, text: 'hello' })]);
  });

  it('asks the person to confirm, then sends once and audits it', async () => {
    h = await makeHarness({ policy: enabled() });
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(h.elicitations).toHaveLength(1);
    expect(h.elicitations[0]).toContain('Alice');
    expect(h.elicitations[0]).toContain('hello');
    expect(r.structuredContent).toMatchObject({ sent: true, message_id: '3EB0SENT0001', to: { jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' } });
    const sends = await sendArgv();
    expect(sends).toHaveLength(1);
    expect(sends[0]!.argv).toEqual(['--json', '--timeout', '85s', 'send', 'text', '--to=61400000001@s.whatsapp.net', '--message=hello']);
    expect(sends[0]!.env.WACLI_READONLY).toBeUndefined();
    expect(h.audits.at(-1)).toMatchObject({ tool: 'send_text', outcome: 'sent', message_id: '3EB0SENT0001', text: 'hello' });
  });

  it('passes reply, mentions and no-preview flags', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    await h.call('send_text', { to: 'Alice', message: 'see above', reply_to: 'MSG1', reply_to_sender: '61400000001@s.whatsapp.net', mentions: ['+61400000001'], link_preview: false });
    const [send] = await sendArgv();
    expect(send!.argv.slice(3)).toEqual(['send', 'text', '--to=61400000001@s.whatsapp.net', '--message=see above', '--reply-to=MSG1', '--reply-to-sender=61400000001@s.whatsapp.net', '--mention=+61400000001', '--no-preview']);
    expect(h.elicitations).toHaveLength(0);
  });

  it('keeps a message beginning with dashes as the message', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    const r = await h.call('send_text', { to: 'Alice', message: '--help' });
    expect(r.isError).toBeFalsy();
    const [send] = await sendArgv();
    expect(send!.argv).toContain('--message=--help');
  });

  it('does not send when the person declines or leaves the box unticked', async () => {
    h = await makeHarness({ policy: enabled(), elicit: () => ({ action: 'decline' }) });
    let r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(errorOf(r).error).toBe('confirmation_declined');
    expect(await sendArgv()).toHaveLength(0);
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'denied', reason: 'confirmation_declined' });
    await h.close();

    h = await makeHarness({ policy: enabled(), elicit: () => ({ action: 'accept', content: { confirm: false } }) });
    r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(errorOf(r).error).toBe('confirmation_declined');
    expect(await sendArgv()).toHaveLength(0);
  });

  it('refuses when confirmation is needed but the client cannot show a form', async () => {
    h = await makeHarness({ policy: enabled(), elicitation: 'none' });
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(errorOf(r)).toMatchObject({ error: 'confirmation_unavailable', message: expect.stringContaining('policy allow') });
    await h.close();
    h = await makeHarness({ policy: enabled(), elicitation: 'url-only' });
    expect(errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' })).error).toBe('confirmation_unavailable');
  });

  it('sends to an allowlisted recipient without a prompt in unlisted mode', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'unlisted', allow: ['+61 400 000 001'] }), elicitation: 'none' });
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(await sendArgv()).toHaveLength(1);
  });

  it('gates groups', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    expect(errorOf(await h.call('send_text', { to: 'Family', message: 'hi all' })).error).toBe('groups_disabled');
    await h.close();
    h = await makeHarness({ policy: enabled({ confirm: 'never', groups: true }) });
    expect((await h.call('send_text', { to: 'Family', message: 'hi all' })).isError).toBeFalsy();
  });

  it('rate limits by minimum gap and by hourly window', async () => {
    const now = new Date('2026-10-20T10:00:00Z');
    h = await makeHarness({ policy: enabled({ confirm: 'never', rateLimit: { perHour: 20, minGapSeconds: 5 } }), now });
    expect((await h.call('send_text', { to: 'Alice', message: 'one' })).isError).toBeFalsy();
    const r = await h.call('send_text', { to: 'Alice', message: 'two' });
    expect(errorOf(r)).toMatchObject({ error: 'rate_limited', retry_after_seconds: 5 });
    await h.close();

    h = await makeHarness({ policy: enabled({ confirm: 'never', rateLimit: { perHour: 2, minGapSeconds: 0 } }), now });
    expect((await h.call('send_text', { to: 'Alice', message: 'one' })).isError).toBeFalsy();
    expect((await h.call('send_text', { to: 'Alice', message: 'two' })).isError).toBeFalsy();
    const third = await h.call('send_text', { to: 'Alice', message: 'three' });
    expect(errorOf(third)).toMatchObject({ error: 'rate_limited', retry_after_seconds: 3600 });
    expect(await sendArgv()).toHaveLength(2);
  });

  it('serialises concurrent sends so the hourly window cannot be exceeded', async () => {
    const now = new Date('2026-10-20T10:00:00Z');
    h = await makeHarness({ policy: enabled({ confirm: 'never', rateLimit: { perHour: 2, minGapSeconds: 0 } }), now });
    const results = await Promise.all(['a', 'b', 'c', 'd'].map((m) => h.call('send_text', { to: 'Alice', message: m })));
    expect(results.filter((r) => !r.isError)).toHaveLength(2);
    expect(results.filter((r) => r.isError && errorOf(r).error === 'rate_limited')).toHaveLength(2);
    expect(await sendArgv()).toHaveLength(2);
  });

  it('refuses a send when the rate-limit state cannot be read, instead of counting from zero', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    await mkdir(h.deps.paths.rateLimitFile, { recursive: true }); // a directory where the state file belongs
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ error: 'invalid_input', message: expect.stringContaining('Could not read the rate-limit state at') });
    expect(await sendArgv()).toHaveLength(0);
    expect(h.audits.at(-1)).toMatchObject({ tool: 'send_text', outcome: 'failed', reason: 'invalid_input' });
  });

  it('re-checks every rule when the confirmation answer arrives', async () => {
    h = await makeHarness({
      policy: enabled(),
      elicit: () => {
        h.deps.startupPolicy.writes.enabled = false;
        return { action: 'accept', content: { confirm: true } };
      },
    });
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(errorOf(r).error).toBe('writes_disabled');
    expect(h.elicitations).toHaveLength(1);
    expect(await sendArgv()).toHaveLength(0);
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'denied', reason: 'writes_disabled' });
    await h.close();

    h = await makeHarness({
      policy: enabled(),
      elicit: () => {
        h.deps.startupPolicy.writes.rateLimit.perHour = 0;
        return { action: 'accept', content: { confirm: true } };
      },
    });
    const limited = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(errorOf(limited)).toMatchObject({ error: 'rate_limited', retry_after_seconds: expect.any(Number) });
    expect(await sendArgv()).toHaveLength(0);
  });

  it('reports an ambiguous recipient and a wacli failure as failed audits', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    expect(errorOf(await h.call('send_text', { to: 'a', message: 'x' })).error).toBe('ambiguous_recipient');
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed', reason: 'ambiguous_recipient', to_jid: null });
    await h.close();
    h = await makeHarness({ policy: enabled({ confirm: 'never' }), env: { FAKE_WACLI_FAIL: 'send text|1|usync failed' } });
    expect(errorOf(await h.call('send_text', { to: 'Alice', message: 'x' })).error).toBe('wacli_error');
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed', reason: 'wacli_error (outcome uncertain, may have been delivered)', uncertain: true });
  });
});

describe('send_file', () => {
  it('refuses without file roots, then sends with WACLI_MEDIA_ROOTS set', async () => {
    const outbox = await makeTmp('wa-outbox-');
    try {
      const file = path.join(outbox, 'report.pdf');
      await writeFile(file, 'pdf');
      h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
      expect(errorOf(await h.call('send_file', { to: 'Alice', path: file })).error).toBe('file_outside_roots');
      await h.close();

      h = await makeHarness({ policy: enabled({ confirm: 'never', fileRoots: [outbox] }) });
      const r = await h.call('send_file', { to: 'Alice', path: file, caption: 'the report', as: 'document' });
      expect(r.isError).toBeFalsy();
      const [send] = (await h.argv()).filter((x) => x.key === 'send file');
      expect(send!.argv.slice(3)).toEqual(['send', 'file', '--to=61400000001@s.whatsapp.net', `--file=${file}`, '--caption=the report', '--as=document']);
      expect(send!.env.WACLI_MEDIA_ROOTS).toBe(outbox);
      expect(h.audits.at(-1)).toMatchObject({ tool: 'send_file', outcome: 'sent', file });
    } finally {
      await removeTmp(outbox);
    }
  });

  it('rejects a relative path', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    expect((await h.call('send_file', { to: 'Alice', path: 'report.pdf' })).isError).toBe(true);
  });
});

describe('react and mark_read', () => {
  it('reacts after confirmation and audits the reaction', async () => {
    h = await makeHarness({ policy: enabled() });
    const r = await h.call('react', { chat: 'Alice', message_id: 'MSG1', reaction: '❤️' });
    expect(r.isError).toBeFalsy();
    expect(h.elicitations[0]).toContain('❤️');
    const [send] = (await h.argv()).filter((x) => x.key === 'send react');
    expect(send!.argv.slice(3)).toEqual(['send', 'react', '--to=61400000001@s.whatsapp.net', '--id=MSG1', '--reaction=❤️']);
    expect(h.audits.at(-1)).toMatchObject({ tool: 'react', outcome: 'sent', reaction: '❤️' });
  });

  it('rejects an over-long reaction', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    expect((await h.call('react', { chat: 'Alice', message_id: 'MSG1', reaction: '😀😀😀😀😀😀😀😀😀' })).isError).toBe(true);
  });

  it('does not call a failed mark_read uncertain, because repeating it is harmless', async () => {
    h = await makeHarness({ policy: enabled(), env: { FAKE_WACLI_FAIL: 'chats mark-read|1|connection reset by peer' } });
    const r = await h.call('mark_read', { chat: 'Alice' });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ error: 'wacli_error', message: 'connection reset by peer' });
    expect(errorOf(r).outcome_uncertain).toBeUndefined();
    await h.close();

    h = await makeHarness({ policy: enabled({ confirm: 'never' }), env: { FAKE_WACLI_FAIL: 'send text|1|connection reset by peer' } });
    const sent = errorOf(await h.call('send_text', { to: 'Alice', message: 'x' }));
    expect(sent).toMatchObject({ error: 'wacli_error', outcome_uncertain: true });
  });

  it('marks read without a prompt once writes are enabled', async () => {
    h = await makeHarness({ policy: enabled() });
    const r = await h.call('mark_read', { chat: 'Alice' });
    expect(r.isError).toBeFalsy();
    expect(h.elicitations).toHaveLength(0);
    const [cmd] = (await h.argv()).filter((x) => x.key === 'chats mark-read');
    expect(cmd!.argv.slice(3)).toEqual(['chats', 'mark-read', '--chat=61400000001@s.whatsapp.net']);
    expect(r.structuredContent).toMatchObject({ ok: true, chat: { jid: '61400000001@s.whatsapp.net' } });
  });
});

describe('names are matched exactly for writes', () => {
  const PLUMBING = '61400000012@s.whatsapp.net';
  const row = (jid: string, name: string) => ({ jid, kind: 'dm', name, last_message_ts: '2026-10-19T09:00:00Z', archived: false, pinned: false, muted_until: 0, unread: false, unread_count: 0 });
  const contact = (jid: string, name: string) => ({ jid, phone: `+${jid.split('@')[0]}`, name, alias: '', system_name: '', updated_at: '2026-10-19T08:00:00Z' });
  const envelope = (data: unknown) => JSON.stringify({ success: true, data, error: null });

  async function withDave(fn: (env: Record<string, string>) => Promise<void>): Promise<void> {
    const dir = await fixturesWith({
      'chats_list.json': envelope([row(PLUMBING, "Dave's Plumbing")]),
      'contacts_search.json': envelope([contact('61400000013@s.whatsapp.net', 'David Smith')]),
    });
    try {
      await fn({ FAKE_WACLI_FIXTURES: dir });
    } finally {
      await removeTmp(dir);
    }
  }

  const calls: Array<[string, Record<string, unknown>, string]> = [
    ['send_text', { to: 'Dave', message: 'hello' }, 'send text'],
    ['send_file', { to: 'Dave', path: '/tmp/none.pdf' }, 'send file'],
    ['react', { chat: 'Dave', message_id: 'MSG1', reaction: '👍' }, 'send react'],
    ['mark_read', { chat: 'Dave' }, 'chats mark-read'],
  ];

  it.each(calls)('%s refuses a lone partial match and offers it as the one candidate', async (tool, args, key) => {
    await withDave(async (env) => {
      h = await makeHarness({ policy: enabled({ confirm: 'never' }), env });
      const r = await h.call(tool, args);
      expect(r.isError).toBe(true);
      expect(errorOf(r)).toMatchObject({
        error: 'ambiguous_recipient',
        message: 'No chat or contact is named exactly "Dave". Use the exact name or the JID.',
        candidates: [{ jid: PLUMBING, name: "Dave's Plumbing", kind: 'user' }],
      });
      expect((await h.argv()).filter((x) => x.key === key)).toHaveLength(0);
      expect(h.audits.at(-1)).toMatchObject({ tool, outcome: 'failed', reason: 'ambiguous_recipient', to_jid: null });
    });
  });

  it('sends when the whole name is given, and when the JID is', async () => {
    await withDave(async (env) => {
      h = await makeHarness({ policy: enabled({ confirm: 'never', rateLimit: { perHour: 20, minGapSeconds: 0 } }), env });
      expect((await h.call('send_text', { to: "Dave's Plumbing", message: 'hello' })).isError).toBeFalsy();
      expect((await h.call('send_text', { to: PLUMBING, message: 'hello again' })).isError).toBeFalsy();
      expect(await sendArgv()).toHaveLength(2);
      expect(h.audits.filter((a) => a.outcome === 'sent').every((a) => a.to_jid === PLUMBING)).toBe(true);
    });
  });

  it('never prompts for a name that is not exact, so the person is not asked to approve a guess', async () => {
    await withDave(async (env) => {
      h = await makeHarness({ policy: enabled(), env });
      expect(errorOf(await h.call('send_text', { to: 'Dave', message: 'hello' })).error).toBe('ambiguous_recipient');
      expect(h.elicitations).toHaveLength(0);
    });
  });
});

describe('the master switch comes before the recipient lookup', () => {
  const calls: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['send_text', { to: 'a', message: 'hello' }, { text: 'hello' }],
    ['send_file', { to: 'a', path: '/tmp/none.pdf' }, { file: '/tmp/none.pdf' }],
    ['react', { chat: 'a', message_id: 'MSG1', reaction: '👍' }, { reaction: '👍', message_id: 'MSG1' }],
    ['mark_read', { chat: 'a' }, {}],
  ];

  it.each(calls)('%s gives writes_disabled for an ambiguous name, spawns nothing and audits a denial', async (tool, args, audited) => {
    h = await makeHarness();
    const r = await h.call(tool, args);
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ error: 'writes_disabled', message: expect.stringContaining('policy enable') });
    expect(await h.argv()).toEqual([]);
    expect(h.audits).toEqual([expect.objectContaining({ tool, outcome: 'denied', reason: 'writes_disabled', to_jid: null, ...audited })]);
  });

  it('still looks the name up once writes are on', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    expect(errorOf(await h.call('send_text', { to: 'a', message: 'hello' })).error).toBe('ambiguous_recipient');
    expect((await h.argv()).map((x) => x.key)).toEqual(['chats list']);
  });
});

describe('the attempted row', () => {
  const rows = () => h.audits.map((a) => a.outcome);

  it('comes before the call to wacli, and the sent row after it', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    let seenByWacli: string[] = [];
    stubWrite(h, async () => {
      seenByWacli = rows();
      return { sent: true, to: '61400000001@s.whatsapp.net', id: 'ORDER0001' };
    });
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(seenByWacli).toEqual(['attempted']);
    expect(rows()).toEqual(['attempted', 'sent']);
    expect(h.audits[0]).toMatchObject({ tool: 'send_text', outcome: 'attempted', to_jid: '61400000001@s.whatsapp.net', to_name: 'Alice', kind: 'user', text: 'hello' });
    expect(h.audits[0]).not.toHaveProperty('message_id');
    expect(h.audits[1]).toMatchObject({ outcome: 'sent', message_id: 'ORDER0001', text: 'hello' });
  });

  it('is followed by a failed row when wacli fails', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }), env: { FAKE_WACLI_FAIL: 'send text|1|usync failed' } });
    expect(errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' })).error).toBe('wacli_error');
    expect(rows()).toEqual(['attempted', 'failed']);
    expect(h.audits[1]).toMatchObject({ outcome: 'failed', reason: 'wacli_error (outcome uncertain, may have been delivered)', uncertain: true });
  });

  it('precedes every kind of write', async () => {
    const outbox = await makeTmp('wa-outbox-');
    try {
      const file = path.join(outbox, 'report.pdf');
      await writeFile(file, 'pdf');
      h = await makeHarness({ policy: enabled({ confirm: 'never', fileRoots: [outbox], rateLimit: { perHour: 50, minGapSeconds: 0 } }) });
      const seen: string[][] = [];
      stubWrite(h, async () => {
        seen.push(rows());
        return { sent: true, to: '61400000001@s.whatsapp.net', id: 'ORDER0002', ok: true };
      });
      await h.call('send_file', { to: 'Alice', path: file, caption: 'the report' });
      await h.call('react', { chat: 'Alice', message_id: 'MSG1', reaction: '👍' });
      await h.call('mark_read', { chat: 'Alice' });
      expect(seen).toEqual([['attempted'], ['attempted', 'sent', 'attempted'], ['attempted', 'sent', 'attempted', 'sent', 'attempted']]);
      expect(h.audits.filter((a) => a.outcome === 'attempted')).toEqual([
        expect.objectContaining({ tool: 'send_file', file, text: 'the report' }),
        expect.objectContaining({ tool: 'react', reaction: '👍', message_id: 'MSG1' }),
        expect.objectContaining({ tool: 'mark_read', to_jid: '61400000001@s.whatsapp.net' }),
      ]);
    } finally {
      await removeTmp(outbox);
    }
  });

  it('is not written for a send that is denied, declined or still waiting for an answer', async () => {
    h = await makeHarness({ policy: enabled(), manualRounds: true });
    const waiting = await h.callRound('send_text', { to: 'Alice', message: 'hello' });
    expect(waiting.resultType).toBe('input_required');
    expect(h.audits).toEqual([]);

    const declined = await h.callRound('send_text', { to: 'Alice', message: 'hello' }, { inputResponses: { confirm: { action: 'decline' } }, requestState: waiting.requestState });
    expect(JSON.parse(declined.content![0]!.text!)).toMatchObject({ error: 'confirmation_declined' });
    expect(rows()).toEqual(['denied']);
    await h.close();

    h = await makeHarness({ policy: enabled({ groups: false, confirm: 'never' }) });
    await h.call('send_text', { to: 'Family', message: 'hi all' });
    expect(rows()).toEqual(['denied']);
  });

  it('is written once, after the person says yes, when a prompt was shown', async () => {
    h = await makeHarness({ policy: enabled() });
    expect((await h.call('send_text', { to: 'Alice', message: 'hello' })).isError).toBeFalsy();
    expect(h.elicitations).toHaveLength(1);
    expect(rows()).toEqual(['attempted', 'sent']);
  });

  it('blocks the send when it cannot be written, and says so', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    h.deps.audit = async () => { throw new Error('ENOSPC: no space left on device'); };
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ error: 'invalid_input', message: expect.stringContaining('Could not write the audit log at') });
    expect(errorOf(r).message).toContain('ENOSPC: no space left on device');
    expect(errorOf(r).message).toContain('Nothing was sent.');
    expect(await sendArgv()).toHaveLength(0);
  });

  it.each([
    ['send_text', { to: 'Alice', message: 'hello' }, 'send text'],
    ['react', { chat: 'Alice', message_id: 'MSG1', reaction: '👍' }, 'send react'],
    ['mark_read', { chat: 'Alice' }, 'chats mark-read'],
  ])('keeps %s from reaching wacli when the row cannot be written', async (tool, args, key) => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    h.deps.audit = async () => { throw new Error('EACCES: permission denied'); };
    expect(errorOf(await h.call(tool, args)).error).toBe('invalid_input');
    expect((await h.argv()).filter((x) => x.key === key)).toHaveLength(0);
  });

  it('keeps send_file from reaching wacli when the row cannot be written', async () => {
    const outbox = await makeTmp('wa-outbox-');
    try {
      const file = path.join(outbox, 'report.pdf');
      await writeFile(file, 'pdf');
      h = await makeHarness({ policy: enabled({ confirm: 'never', fileRoots: [outbox] }) });
      h.deps.audit = async () => { throw new Error('EROFS: read-only file system'); };
      expect(errorOf(await h.call('send_file', { to: 'Alice', path: file })).error).toBe('invalid_input');
      expect((await h.argv()).filter((x) => x.key === 'send file')).toHaveLength(0);
    } finally {
      await removeTmp(outbox);
    }
  });

  it('is released from the in-flight count even when it fails', async () => {
    h = await makeHarness({ policy: enabled({ confirm: 'never' }) });
    h.deps.audit = async () => { throw new Error('ENOSPC'); };
    await h.call('send_text', { to: 'Alice', message: 'hello' });
    const { drainInFlight } = await import('../../src/mcp/tools/send.js');
    const t0 = Date.now();
    await drainInFlight(1500);
    expect(Date.now() - t0).toBeLessThan(700);
  });
});

describe('a failure after the write has been handed to wacli is uncertain', () => {
  const rows = () => h.audits.map((a) => a.outcome);
  const SUFFIX = ' (outcome uncertain, may have been delivered)';
  const never = enabled({ confirm: 'never', rateLimit: { perHour: 50, minGapSeconds: 0 } });

  it.each([[{}], [null], [undefined], [{ id: 42 }], ['3EB0']])('treats an answer of %j without a usable id as a send with no id, not as a failure', async (answer) => {
    h = await makeHarness({ policy: never });
    stubWrite(h, async () => answer);
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ sent: true, message_id: '', to: { jid: '61400000001@s.whatsapp.net' } });
    expect(rows()).toEqual(['attempted', 'sent']);
    expect(h.audits[1]).not.toHaveProperty('message_id');
  });

  it('does the same for a reaction and a file', async () => {
    const outbox = await makeTmp('wa-outbox-');
    try {
      const file = path.join(outbox, 'report.pdf');
      await writeFile(file, 'pdf');
      h = await makeHarness({ policy: enabled({ confirm: 'never', fileRoots: [outbox], rateLimit: { perHour: 50, minGapSeconds: 0 } }) });
      stubWrite(h, async () => null);
      const react = await h.call('react', { chat: 'Alice', message_id: 'MSG1', reaction: '👍' });
      expect(react.isError).toBeFalsy();
      expect(react.structuredContent).toMatchObject({ sent: true, message_id: '' });
      const sent = await h.call('send_file', { to: 'Alice', path: file });
      expect(sent.isError).toBeFalsy();
      expect(sent.structuredContent).toMatchObject({ sent: true, message_id: '' });
      expect(h.audits.find((a) => a.tool === 'react' && a.outcome === 'sent')).toMatchObject({ message_id: 'MSG1', reaction: '👍' });
    } finally {
      await removeTmp(outbox);
    }
  });

  it('tells the agent a timeout is uncertain and records the row as uncertain', async () => {
    h = await makeHarness({ policy: never, env: { FAKE_WACLI_FAIL: 'send text|1|deadline exceeded' } });
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ error: 'timeout', message: expect.stringContaining('may have gone through'), outcome_uncertain: true });
    expect(rows()).toEqual(['attempted', 'failed']);
    expect(h.audits[1]).toMatchObject({ outcome: 'failed', reason: `timeout${SUFFIX}`, uncertain: true, text: 'hello' });
  });

  it('does the same for a wacli_error from a write', async () => {
    h = await makeHarness({ policy: never, env: { FAKE_WACLI_FAIL: 'send text|1|connection reset by peer' } });
    const e = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(e).toMatchObject({ error: 'wacli_error', message: expect.stringContaining(SEND_UNCERTAIN), outcome_uncertain: true });
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed', reason: `wacli_error${SUFFIX}`, uncertain: true });
  });

  it('wraps a plain error that comes out of the write, because wacli may have run', async () => {
    h = await makeHarness({ policy: never });
    stubWrite(h, async () => { throw new Error('socket hang up'); });
    const e = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(e).toMatchObject({ error: 'wacli_error', message: `socket hang up. ${SEND_UNCERTAIN}`, outcome_uncertain: true });
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed', reason: `wacli_error${SUFFIX}`, uncertain: true });
  });

  it('wraps a failure that happens once the write has returned, such as reading the answer', async () => {
    h = await makeHarness({ policy: never });
    stubWrite(h, async () => ({ get id(): string { throw new Error('boom'); } }));
    const e = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(e).toMatchObject({ error: 'wacli_error', message: `boom. ${SEND_UNCERTAIN}`, outcome_uncertain: true });
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed', uncertain: true });
  });

  it('tells the agent the outcome is uncertain when the audit log fails after a successful send', async () => {
    h = await makeHarness({ policy: never });
    const write = h.deps.audit;
    h.deps.audit = async (rec) => {
      if (rec.outcome === 'sent') throw new Error('ENOSPC: no space left on device');
      return write(rec);
    };
    const r = await h.call('send_text', { to: 'Alice', message: 'hello' });
    expect(r.isError).toBe(true);
    const e = errorOf(r);
    expect(e).toMatchObject({ error: 'invalid_input', outcome_uncertain: true });
    expect(e.message).toContain('Could not write the audit log at');
    expect(e.message).toContain('ENOSPC: no space left on device');
    expect(e.message).toContain(SEND_UNCERTAIN);
    expect(e.message).not.toContain('Nothing was sent');
    expect(await sendArgv()).toHaveLength(1);
    expect(rows()).toEqual(['attempted', 'failed']);
    expect(h.audits[1]).toMatchObject({ outcome: 'failed', reason: `invalid_input${SUFFIX}`, uncertain: true });
  });

  it('still answers when the audit log is gone altogether after the send', async () => {
    h = await makeHarness({ policy: never });
    const write = h.deps.audit;
    h.deps.audit = async (rec) => {
      if (rec.outcome === 'attempted') return write(rec);
      throw new Error('EIO: i/o error');
    };
    const e = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(e).toMatchObject({ error: 'invalid_input', outcome_uncertain: true });
    expect(rows()).toEqual(['attempted']);
  });

  it('leaves an error from before the spawn alone: a NUL byte reaches the agent unchanged and nothing is marked uncertain', async () => {
    h = await makeHarness({ policy: never });
    const r = await h.call('send_text', { to: 'Alice', message: 'null\u0000byte' });
    expect(r.isError).toBe(true);
    const e = errorOf(r);
    expect(e).toEqual({ error: 'invalid_input', message: 'Input must not contain NUL characters.' });
    expect(rows()).toEqual(['attempted', 'failed']);
    expect(h.audits[1]).toMatchObject({ outcome: 'failed', reason: 'invalid_input' });
    expect(h.audits[1]).not.toHaveProperty('uncertain');
    expect(rows()).not.toContain('sent');
    expect(await sendArgv()).toHaveLength(0);
  });

  it('leaves a wacli that is too old for a flag alone', async () => {
    h = await makeHarness({ policy: never, env: { FAKE_WACLI_FAIL: 'send text|1|Error: unknown flag: --timeout' } });
    const e = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(e).toMatchObject({ error: 'wacli_too_old', message: expect.stringContaining('older than the minimum') });
    expect(e).not.toHaveProperty('outcome_uncertain');
    expect(e.message).not.toContain('uncertain');
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed', reason: 'wacli_too_old' });
    expect(h.audits.at(-1)).not.toHaveProperty('uncertain');
  });

  it('leaves a spawn that never started alone', async () => {
    const dir = await makeTmp('wa-noexec-');
    try {
      const copy = path.join(dir, 'wacli');
      await copyFile(FAKE_WACLI, copy);
      await chmod(copy, 0o644);
      const broken = createRunner({ bin: copy, baseEnv: fakeEnv() });
      h = await makeHarness({ policy: never });
      stubWrite(h, (args, opts) => broken.write(args, opts));
      const e = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
      expect(e).toMatchObject({ error: 'wacli_error', spawn_code: expect.stringMatching(/^E(ACCES|PERM)$/) });
      expect(e).not.toHaveProperty('outcome_uncertain');
      expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed', reason: 'wacli_error' });
      expect(h.audits.at(-1)).not.toHaveProperty('uncertain');
    } finally {
      await removeTmp(dir);
    }
  });

  it.each([
    ['not authenticated; run `wacli auth`', 'not_authenticated'],
    ['store is locked by another process', 'store_locked'],
    ['chat not found', 'not_found'],
  ])('leaves a definite refusal from wacli alone: %s', async (message, code) => {
    h = await makeHarness({ policy: never, env: { FAKE_WACLI_FAIL: `send text|1|${message}` } });
    const e = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(e.error).toBe(code);
    expect(e).not.toHaveProperty('outcome_uncertain');
    expect(h.audits.at(-1)).toMatchObject({ outcome: 'failed', reason: code });
    expect(h.audits.at(-1)).not.toHaveProperty('uncertain');
  });

  it('leaves a failure before the write alone: an unreadable rate-limit state and a missing attempted row', async () => {
    h = await makeHarness({ policy: never });
    await mkdir(h.deps.paths.rateLimitFile, { recursive: true });
    const first = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(first).toMatchObject({ error: 'invalid_input' });
    expect(first).not.toHaveProperty('outcome_uncertain');
    expect(rows()).toEqual(['failed']);
    await h.close();

    h = await makeHarness({ policy: never });
    h.deps.audit = async () => { throw new Error('ENOSPC'); };
    const second = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(second).toMatchObject({ error: 'invalid_input', message: expect.stringContaining('Nothing was sent.') });
    expect(second).not.toHaveProperty('outcome_uncertain');
  });

  it('never calls a failed mark_read uncertain, whether wacli or the audit log fails', async () => {
    h = await makeHarness({ policy: never, env: { FAKE_WACLI_FAIL: 'chats mark-read|1|connection reset by peer' } });
    const wacli = errorOf(await h.call('mark_read', { chat: 'Alice' }));
    expect(wacli).toMatchObject({ error: 'wacli_error' });
    expect(wacli).not.toHaveProperty('outcome_uncertain');
    expect(h.audits.at(-1)).not.toHaveProperty('uncertain');
    await h.close();

    h = await makeHarness({ policy: never });
    const write = h.deps.audit;
    h.deps.audit = async (rec) => {
      if (rec.outcome === 'sent') throw new Error('ENOSPC');
      return write(rec);
    };
    const audit = errorOf(await h.call('mark_read', { chat: 'Alice' }));
    expect(audit).toMatchObject({ error: 'invalid_input' });
    expect(audit).not.toHaveProperty('outcome_uncertain');
    expect(audit.message).not.toContain('uncertain');
  });

  it('wraps an AgentError thrown after the write too, whatever its code', async () => {
    h = await makeHarness({ policy: never });
    stubWrite(h, async () => ({ get id(): string { throw new AgentError('not_found', 'late surprise'); } }));
    const e = errorOf(await h.call('send_text', { to: 'Alice', message: 'hello' }));
    expect(e).toMatchObject({ error: 'not_found', message: `late surprise. ${SEND_UNCERTAIN}`, outcome_uncertain: true });
  });
});
