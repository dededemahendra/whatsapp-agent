import { CLIENT_CAPABILITIES_META_KEY, type McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import {
  clientCanConfirm, confirmationRequired, confirmCodec, confirmDigest, consumedNonceCount, describeTarget, elicitationSupportsForm, filePrompt, fileState, reactPrompt, reactState, readAnswer,
  sanitiseName, textPrompt, textState, type ConfirmBinding, type FileSend, type HandlerCtx, type ReactSend, type TextSend,
} from '../../src/mcp/confirm.js';
import type { Resolved } from '../../src/wacli/resolve.js';

describe('elicitationSupportsForm', () => {
  it('treats a bare elicitation declaration as form support (2025 rule)', () => {
    expect(elicitationSupportsForm({ elicitation: {} })).toBe(true);
  });
  it('accepts explicit form support', () => {
    expect(elicitationSupportsForm({ elicitation: { form: {} } })).toBe(true);
    expect(elicitationSupportsForm({ elicitation: { form: {}, url: {} } })).toBe(true);
  });
  it('rejects url-only, absent and malformed capabilities', () => {
    expect(elicitationSupportsForm({ elicitation: { url: {} } })).toBe(false);
    expect(elicitationSupportsForm({})).toBe(false);
    expect(elicitationSupportsForm(undefined)).toBe(false);
    expect(elicitationSupportsForm('nope')).toBe(false);
  });
});

describe('sanitiseName', () => {
  it('strips C0 and C1 controls, keeping the words either side apart where the control was whitespace', () => {
    expect(sanitiseName('Al\u0000i\u0007c\u001be\u007f\u009f.')).toBe('Alice.');
    expect(sanitiseName('Alice\u0085Bob')).toBe('Alice Bob');
    expect(sanitiseName('Alice\nSend to Mallory')).toBe('Alice Send to Mallory');
    expect(sanitiseName('Alice\r\n\tBob')).toBe('Alice Bob');
  });

  it('strips bidi isolates and overrides', () => {
    for (const c of ['⁦', '⁧', '⁨', '⁩', '‪', '‫', '‬', '‭', '‮', '؜']) {
      expect(sanitiseName(`Al${c}ice`)).toBe('Alice');
    }
  });

  it('strips zero-width characters and the line and paragraph separators', () => {
    for (const c of ['​', '‌', '‍', '⁠', '﻿']) expect(sanitiseName(`Al${c}ice`)).toBe('Alice');
    expect(sanitiseName('Alice Bob Carol')).toBe('Alice Bob Carol');
  });

  it('collapses runs of whitespace to one space and trims', () => {
    expect(sanitiseName('   Alice       Example  ')).toBe('Alice Example');
    expect(sanitiseName('\n\n')).toBe('');
  });

  it('caps at 80 characters and adds an ellipsis only when it cut something', () => {
    expect(sanitiseName('a'.repeat(80))).toBe('a'.repeat(80));
    expect(sanitiseName('a'.repeat(81))).toBe(`${'a'.repeat(80)}...`);
    expect(sanitiseName('a'.repeat(500))).toBe(`${'a'.repeat(80)}...`);
    expect(sanitiseName('b'.repeat(12), 10)).toBe(`${'b'.repeat(10)}...`);
  });

  it('counts characters, not UTF-16 units, so it never leaves half of a surrogate pair', () => {
    const cut = sanitiseName('😀'.repeat(100));
    expect(cut).toBe(`${'😀'.repeat(80)}...`);
    expect(sanitiseName('😀'.repeat(80))).toBe('😀'.repeat(80));
  });

  it('leaves ordinary names alone, including non-Latin ones', () => {
    expect(sanitiseName("Dave's Plumbing & Gas")).toBe("Dave's Plumbing & Gas");
    expect(sanitiseName('山田 太郎')).toBe('山田 太郎');
    expect(sanitiseName('Zoë')).toBe('Zoë');
  });
});

describe('clientCanConfirm', () => {
  const form = { elicitation: { form: {} } };
  const serverAt = (version: string | undefined, declared: unknown): McpServer =>
    ({ server: { getNegotiatedProtocolVersion: () => version, getClientCapabilities: () => declared } }) as unknown as McpServer;
  const ctxWith = (claim: unknown): HandlerCtx => ({ mcpReq: { envelope: claim === undefined ? undefined : { [CLIENT_CAPABILITIES_META_KEY]: claim }, requestState: () => undefined } });

  it('reads the per-request envelope on a 2026-07-28 connection', () => {
    expect(clientCanConfirm(serverAt('2026-07-28', undefined), ctxWith(form))).toBe(true);
    expect(clientCanConfirm(serverAt('2026-07-28', form), ctxWith({}))).toBe(false);
    expect(clientCanConfirm(serverAt('2026-07-28', undefined), ctxWith(undefined))).toBe(false);
  });

  it('reads what the client declared at initialize on a 2025-era connection, and ignores a _meta claim', () => {
    expect(clientCanConfirm(serverAt('2025-06-18', form), ctxWith(undefined))).toBe(true);
    expect(clientCanConfirm(serverAt('2025-06-18', {}), ctxWith(form))).toBe(false);
    expect(clientCanConfirm(serverAt('2025-11-25', undefined), ctxWith(form))).toBe(false);
    expect(clientCanConfirm(serverAt('2025-06-18', form), ctxWith({}))).toBe(true);
  });

  it('cannot confirm before any handshake', () => {
    expect(clientCanConfirm(serverAt(undefined, undefined), ctxWith(form))).toBe(false);
  });
});

describe('what a confirmation is bound to', () => {
  const alice: Resolved = { jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' };
  const family: Resolved = { jid: '120363000000000001@g.us', name: 'Family', kind: 'group' };
  const text: TextSend = { text: 'hello', replyTo: 'MSG1', replyToSender: '61400000002@s.whatsapp.net', mentions: ['+61400000002'], linkPreview: false };
  const file: FileSend = { realPath: '/home/me/Outbox/report.pdf', size: 1234, mtimeMs: 1_760_000_000_123.5, caption: 'the report', as: 'document', filename: 'q3.pdf' };
  const react: ReactSend = { reaction: '❤️', messageId: 'MSG9', sender: '61400000002@s.whatsapp.net' };

  it('is stable for the same send and different for any change to it', () => {
    const base = textState(alice, text).digest;
    expect(textState(alice, { ...text }).digest).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    const changed: Array<[string, TextSend]> = [
      ['text', { ...text, text: 'hello again' }],
      ['reply_to', { ...text, replyTo: 'MSG2' }],
      ['reply_to_sender', { ...text, replyToSender: '61400000003@s.whatsapp.net' }],
      ['mentions', { ...text, mentions: ['+61400000003'] }],
      ['mentions order', { ...text, mentions: ['+61400000002', '+61400000003'] }],
      ['link_preview', { ...text, linkPreview: true }],
    ];
    for (const [what, variant] of changed) expect(textState(alice, variant).digest, what).not.toBe(base);
    expect(textState(alice, { ...text, mentions: ['+61400000003', '+61400000002'] }).digest).not.toBe(textState(alice, { ...text, mentions: ['+61400000002', '+61400000003'] }).digest);
  });

  it('treats an option left out the same as that option at its default', () => {
    const bare: TextSend = { text: 'hello' };
    expect(textState(alice, { ...bare, linkPreview: true }).digest).toBe(textState(alice, bare).digest);
    expect(textState(alice, { ...bare, mentions: [] }).digest).toBe(textState(alice, bare).digest);
    expect(fileState(alice, { ...file, as: undefined }).digest).toBe(fileState(alice, { ...file, as: 'auto' }).digest);
  });

  it('changes with the recipient, its kind and the kind of send', () => {
    const a = textState(alice, text);
    expect(textState({ ...alice, jid: '61400000009@s.whatsapp.net' }, text).digest).not.toBe(a.digest);
    expect(textState({ ...alice, kind: 'group' }, text).digest).not.toBe(a.digest);
    expect(a).toMatchObject({ kind: 'text', jid: alice.jid, chatKind: 'user' });
    expect(fileState(family, file)).toMatchObject({ kind: 'file', jid: family.jid, chatKind: 'group' });
    expect(reactState(alice, react)).toMatchObject({ kind: 'react', jid: alice.jid, chatKind: 'user' });
  });

  it('covers the file path, size, modification time, caption, type and name', () => {
    const base = fileState(alice, file).digest;
    expect(fileState(alice, { ...file }).digest).toBe(base);
    const changed: Array<[string, FileSend]> = [
      ['path', { ...file, realPath: '/home/me/Outbox/other.pdf' }],
      ['size', { ...file, size: 1235 }],
      ['mtime', { ...file, mtimeMs: file.mtimeMs + 1 }],
      ['caption', { ...file, caption: 'the other report' }],
      ['as', { ...file, as: 'image' }],
      ['filename', { ...file, filename: 'q4.pdf' }],
    ];
    for (const [what, variant] of changed) expect(fileState(alice, variant).digest, what).not.toBe(base);
  });

  it('covers the reaction, the message id and the original sender', () => {
    const base = reactState(alice, react).digest;
    expect(reactState(alice, { ...react }).digest).toBe(base);
    expect(reactState(alice, { ...react, reaction: '👍' }).digest).not.toBe(base);
    expect(reactState(alice, { ...react, messageId: 'MSG10' }).digest).not.toBe(base);
    expect(reactState(alice, { ...react, sender: undefined }).digest).not.toBe(base);
  });

  it('cannot be confused across fields by moving text from one to another', () => {
    const a = confirmDigest('text', alice.jid, 'user', { text: 'ab', caption: 'c' });
    const b = confirmDigest('text', alice.jid, 'user', { text: 'a', caption: 'bc' });
    expect(a).not.toBe(b);
  });

  it('puts the message text in the digest only, never in the state itself', () => {
    expect(JSON.stringify(textState(alice, { text: 'a secret plan' }))).not.toContain('secret');
  });
});

describe('readAnswer', () => {
  const expected: ConfirmBinding = { kind: 'text', jid: '61400000001@s.whatsapp.net', chatKind: 'user', digest: 'd'.repeat(64) };
  const accept = { confirm: { action: 'accept', content: { confirm: true } } };
  const ctx = (inputResponses: Record<string, unknown> | undefined, state: unknown): HandlerCtx => ({ mcpReq: { inputResponses, requestState: (() => state) as HandlerCtx['mcpReq']['requestState'] } });
  let counter = 0;
  /** The state a prompt for `expected` would have carried, with a nonce no other test has used. */
  const stateWith = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ ...expected, nonce: `nonce-${(counter += 1)}-${Math.random().toString(16).slice(2)}`, ...over });

  it('accepts only an accept with the box ticked and a state that matches what is being sent', () => {
    expect(readAnswer(ctx(accept, stateWith()), expected)).toBe('accepted');
  });

  it('asks again when there is no answer yet', () => {
    expect(readAnswer(ctx(undefined, undefined), expected)).toBe('none');
    expect(readAnswer(ctx({}, stateWith()), expected)).toBe('none');
  });

  it('asks again, never accepts, when the state is absent', () => {
    expect(readAnswer(ctx(accept, undefined), expected)).toBe('none');
    expect(readAnswer(ctx(accept, null), expected)).toBe('none');
  });

  it('asks again when the state was minted for something else', () => {
    for (const field of ['kind', 'jid', 'chatKind', 'digest'] as const) {
      expect(readAnswer(ctx(accept, stateWith({ [field]: 'other' })), expected), field).toBe('none');
    }
    expect(readAnswer(ctx(accept, 'a string'), expected)).toBe('none');
    expect(readAnswer(ctx(accept, 42), expected)).toBe('none');
    expect(readAnswer(ctx(accept, []), expected)).toBe('none');
    expect(readAnswer(ctx(accept, {}), expected)).toBe('none');
  });

  it('keeps anything that is not an accept with confirm true as declined', () => {
    expect(readAnswer(ctx({ confirm: { action: 'decline' } }, stateWith()), expected)).toBe('declined');
    expect(readAnswer(ctx({ confirm: { action: 'cancel' } }, stateWith()), expected)).toBe('declined');
    expect(readAnswer(ctx({ confirm: { action: 'accept', content: { confirm: false } } }, stateWith()), expected)).toBe('declined');
    expect(readAnswer(ctx({ confirm: { action: 'accept', content: { confirm: 'yes' } } }, stateWith()), expected)).toBe('declined');
    expect(readAnswer(ctx({ confirm: { action: 'accept' } }, stateWith()), expected)).toBe('declined');
    expect(readAnswer(ctx({ confirm: { action: 'decline' } }, undefined), expected)).toBe('declined');
  });

  describe('a state can be accepted once', () => {
    it('asks again when the same state comes back after it was accepted', () => {
      const state = stateWith();
      expect(readAnswer(ctx(accept, state), expected)).toBe('accepted');
      expect(readAnswer(ctx(accept, { ...state }), expected)).toBe('none');
      expect(readAnswer(ctx(accept, { ...state }), expected)).toBe('none');
    });

    it('accepts another state for the very same send, because every prompt has a nonce of its own', () => {
      const a = stateWith();
      const b = stateWith();
      expect(a.nonce).not.toBe(b.nonce);
      expect(readAnswer(ctx(accept, a), expected)).toBe('accepted');
      expect(readAnswer(ctx(accept, b), expected)).toBe('accepted');
    });

    it('does not use a nonce up on an answer that did not match, so the right call can still use it', () => {
      const state = stateWith();
      expect(readAnswer(ctx(accept, state), { ...expected, digest: 'e'.repeat(64) })).toBe('none');
      expect(readAnswer(ctx(accept, state), expected)).toBe('accepted');
    });

    it('does not use a nonce up on a decline', () => {
      const state = stateWith();
      expect(readAnswer(ctx({ confirm: { action: 'decline' } }, state), expected)).toBe('declined');
      expect(readAnswer(ctx(accept, state), expected)).toBe('accepted');
    });

    it('never accepts a state that has no usable nonce', () => {
      for (const nonce of [undefined, null, '', 7, ['x'], { n: 1 }]) {
        expect(readAnswer(ctx(accept, stateWith({ nonce })), expected), JSON.stringify(nonce)).toBe('none');
      }
      const bare: Record<string, unknown> = { ...expected };
      expect(readAnswer(ctx(accept, bare), expected)).toBe('none');
      expect(readAnswer(ctx(accept, bare), expected)).toBe('none');
    });

    it('remembers a nonce for the state lifetime plus two seconds, then forgets it, pruning whenever an answer is read', () => {
      const now = Date.now();
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(now);
        const first = stateWith();
        const second = stateWith();
        expect(readAnswer(ctx(accept, first), expected)).toBe('accepted');
        expect(readAnswer(ctx(accept, second), expected)).toBe('accepted');
        expect(consumedNonceCount()).toBeGreaterThanOrEqual(2);

        vi.setSystemTime(now + 299_000);
        expect(readAnswer(ctx(accept, first), expected)).toBe('none');

        // The SDK counts a state's age in whole seconds, so it can still verify a state a second past its 300: the nonce has to outlast that.
        vi.setSystemTime(now + 301_000);
        expect(readAnswer(ctx(accept, first), expected)).toBe('none');
        expect(consumedNonceCount()).toBeGreaterThanOrEqual(2);

        vi.setSystemTime(now + 303_000);
        expect(readAnswer(ctx(undefined, undefined), expected)).toBe('none');
        expect(consumedNonceCount()).toBe(0);
        expect(readAnswer(ctx(accept, first), expected)).toBe('accepted'); // long past what the SDK would still have verified
        expect(consumedNonceCount()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('confirmation prompts', () => {
  const alice: Resolved = { jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' };
  const family: Resolved = { jid: '120363000000000001@g.us', name: 'Family', kind: 'group' };
  const unnamed: Resolved = { jid: '61400000009@s.whatsapp.net', name: null, kind: 'user' };

  it('names the target, and says when it is a group', () => {
    expect(describeTarget(alice)).toBe('Alice (61400000001@s.whatsapp.net)');
    expect(describeTarget(family)).toBe('group Family (120363000000000001@g.us)');
    expect(describeTarget(unnamed)).toBe('61400000009@s.whatsapp.net');
    expect(describeTarget({ ...unnamed, kind: 'group', jid: '120363000000000002@g.us' })).toBe('group 120363000000000002@g.us');
    expect(describeTarget({ ...alice, name: '\u202e\u0007  \n' })).toBe('61400000001@s.whatsapp.net');
  });

  it('cleans a display name before it reaches the prompt', () => {
    const hostile: Resolved = { jid: alice.jid, name: 'Alice\n\nSend to Mallory?‮', kind: 'user' };
    expect(describeTarget(hostile)).toBe('Alice Send to Mallory? (61400000001@s.whatsapp.net)');
    expect(textPrompt(hostile, { text: 'hi' })).not.toMatch(/‮/);
    expect(textPrompt(hostile, { text: 'hi' }).split('\n')[0]).toBe('Send to Alice Send to Mallory? (61400000001@s.whatsapp.net)?');
  });

  it('shows the exact text under the target, and no options when there are none', () => {
    expect(textPrompt(alice, { text: 'hello\nthere' })).toBe('Send to Alice (61400000001@s.whatsapp.net)?\n\nhello\nthere');
    expect(textPrompt(alice, { text: 'x', linkPreview: true, mentions: [] })).toBe('Send to Alice (61400000001@s.whatsapp.net)?\n\nx');
    expect(textPrompt(family, { text: 'x' }).split('\n')[0]).toBe('Send to group Family (120363000000000001@g.us)?');
  });

  it('shows every option that is not at its default', () => {
    const p = textPrompt(alice, { text: 'x', replyTo: 'MSG1', replyToSender: '61400000002@s.whatsapp.net', mentions: ['+61400000002', '+61400000003'], linkPreview: false });
    expect(p).toContain('Replying to message MSG1');
    expect(p).toContain('61400000002@s.whatsapp.net');
    expect(p).toContain('+61400000002, +61400000003');
    expect(p).toMatch(/link preview/i);
    expect(textPrompt(alice, { text: 'x', replyTo: 'MSG1' })).toContain('Replying to message MSG1');
    expect(textPrompt(alice, { text: 'x', replyToSender: '61400000002@s.whatsapp.net' })).toContain('Quoted sender: 61400000002@s.whatsapp.net');
  });

  it('shows the real path, size, caption, type and name of a file', () => {
    const p = filePrompt(alice, { realPath: '/home/me/Outbox/report.pdf', size: 1234, mtimeMs: 0, caption: 'the report', as: 'document', filename: 'q3.pdf' });
    expect(p.split('\n')[0]).toBe('Send file to Alice (61400000001@s.whatsapp.net)?');
    expect(p).toContain('/home/me/Outbox/report.pdf (1234 bytes)');
    expect(p).toContain('the report');
    expect(p).toContain('document');
    expect(p).toContain('q3.pdf');
    const bare = filePrompt(family, { realPath: '/home/me/Outbox/report.pdf', size: 1, mtimeMs: 0 });
    expect(bare).toBe('Send file to group Family (120363000000000001@g.us)?\n\n/home/me/Outbox/report.pdf (1 bytes)');
    expect(filePrompt(alice, { realPath: '/a', size: 2, mtimeMs: 0, as: 'auto' })).not.toMatch(/auto/);
  });

  it('cleans a caption and a file name, and caps the caption', () => {
    const p = filePrompt(alice, { realPath: '/a/b.pdf', size: 9, mtimeMs: 0, caption: `line one\nline two‮${'x'.repeat(200)}`, filename: 'evil\u0007.pdf' });
    expect(p).not.toMatch(/‮|\u0007/);
    expect(p).toContain('line one line two');
    expect(p).toContain(`${'x'.repeat(5)}`);
    expect(p).toContain('...');
    expect(p).not.toContain('x'.repeat(100));
    expect(p).toContain('evil.pdf');
  });

  it('names the chat, the message and the reaction when reacting', () => {
    expect(reactPrompt(alice, { reaction: '❤️', messageId: 'MSG9' })).toBe('React with ❤️ to message MSG9 in Alice (61400000001@s.whatsapp.net)?');
    expect(reactPrompt(family, { reaction: '', messageId: 'MSG9' })).toBe('Clear your reaction to message MSG9 in group Family (120363000000000001@g.us)?');
    expect(reactPrompt(alice, { reaction: '👍', messageId: 'MSG9', sender: '61400000002@s.whatsapp.net' })).toContain('61400000002@s.whatsapp.net');
  });
});

describe('the confirmation request', () => {
  const binding: ConfirmBinding = { kind: 'text', jid: '61400000001@s.whatsapp.net', chatKind: 'user', digest: 'a'.repeat(64) };

  it('asks one form question and carries the state as a signed, expiring string', async () => {
    const r = await confirmationRequired('Send to Alice?', binding);
    expect(r.resultType).toBe('input_required');
    expect(Object.keys(r.inputRequests ?? {})).toEqual(['confirm']);
    expect(r.inputRequests!.confirm).toMatchObject({ method: 'elicitation/create', params: { message: 'Send to Alice?', mode: 'form' } });
    expect(await confirmCodec().verify(r.requestState!, undefined as never)).toEqual({ ...binding, nonce: expect.stringMatching(/^[0-9a-f]{32}$/) });
  });

  it('mints a nonce of its own for every prompt, so two prompts for the same send never share a state', async () => {
    const prompts = await Promise.all(Array.from({ length: 25 }, () => confirmationRequired('Send to Alice?', binding)));
    const states = prompts.map((p) => p.requestState!);
    expect(new Set(states).size).toBe(25);
    const nonces = await Promise.all(states.map(async (st) => (await confirmCodec().verify(st, undefined as never)).nonce));
    expect(new Set(nonces).size).toBe(25);
    for (const n of nonces) expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it('uses one codec for the whole process, so a state minted anywhere in it verifies everywhere in it', () => {
    expect(confirmCodec()).toBe(confirmCodec());
  });

  it('does not verify a state from another codec, or one that has been cut short', async () => {
    const r = await confirmationRequired('Send to Alice?', binding);
    await expect(confirmCodec().verify(r.requestState!.slice(0, -4), undefined as never)).rejects.toThrow();
    await expect(confirmCodec().verify(r.requestState!.replace(/^v1\.[^.]+/, 'v1.e30'), undefined as never)).rejects.toThrow();
  });
});
