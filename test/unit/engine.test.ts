import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DENY_MESSAGES, decide, fileInsideRoots, isInsideRoot, matchesAllow, sameAllowTarget, type DecideInput } from '../../src/policy/engine.js';
import { DEFAULT_POLICY, type Policy } from '../../src/policy/schema.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';

const alice = { jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' as const };
const family = { jid: '120363000000000001@g.us', name: 'Family', kind: 'group' as const };
const channel = { jid: '1@newsletter', name: 'News', kind: 'channel' as const };
const broadcast = { jid: 'status@broadcast', name: null, kind: 'broadcast' as const };
const unknown = { jid: 'x@weird', name: 'Odd', kind: 'unknown' as const };
const calm = { countLastHour: 0, secondsSinceLast: null, secondsUntilWindowFrees: 0 };

function policy(over: Partial<Policy['writes']> = {}): Policy {
  return { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true, ...over } };
}
function input(over: Partial<DecideInput> = {}): DecideInput {
  return { policy: policy(), tool: 'send_text', recipient: alice, rate: calm, clientCanConfirm: true, answer: 'none', ...over };
}

describe('matchesAllow', () => {
  it('matches by JID or phone number only, never by name', () => {
    expect(matchesAllow(['61400000001@s.whatsapp.net'], alice)).toBe(true);
    expect(matchesAllow(['+61 400 000 001'], alice)).toBe(true);
    expect(matchesAllow(['+61400000001@s.whatsapp.net'], alice)).toBe(true);
    expect(matchesAllow(['61400000001:7@s.whatsapp.net'], alice)).toBe(true);
    expect(matchesAllow(['61400000001@S.WHATSAPP.NET'], alice)).toBe(true);
    expect(matchesAllow(['61400000001@s.whatsapp.net'], { ...alice, jid: '61400000001:7@s.whatsapp.net' })).toBe(true);
    expect(matchesAllow(['alice'], alice)).toBe(false);
    expect(matchesAllow(['Alice'], alice)).toBe(false);
    expect(matchesAllow(['+61 400 000 002', 'Bob'], alice)).toBe(false);
    expect(matchesAllow([], alice)).toBe(false);
  });
});

describe('sameAllowTarget', () => {
  it('treats spellings of one number, its JID forms, and exact text as the same target', () => {
    expect(sameAllowTarget('+61 400 000 001', '61400000001')).toBe(true);
    expect(sameAllowTarget('+61400000001', '61400000001@s.whatsapp.net')).toBe(true);
    expect(sameAllowTarget('61400000001:7@s.whatsapp.net', '61400000001@S.WHATSAPP.NET')).toBe(true);
    expect(sameAllowTarget('120363000000000001@g.us', '120363000000000001@g.us')).toBe(true);
    expect(sameAllowTarget('+61 400 000 001', '+61 400 000 002')).toBe(false);
    expect(sameAllowTarget('Alice', 'alice')).toBe(true);
    expect(sameAllowTarget('Alice', '+61400000001')).toBe(false);
  });
});

describe('decide', () => {
  it('denies everything while writes are disabled', () => {
    expect(decide(input({ policy: DEFAULT_POLICY }))).toMatchObject({ kind: 'deny', code: 'writes_disabled' });
    expect(decide(input({ policy: DEFAULT_POLICY, tool: 'mark_read' }))).toMatchObject({ kind: 'deny', code: 'writes_disabled' });
  });
  it('allows mark_read without confirmation once enabled', () => {
    expect(decide(input({ tool: 'mark_read', policy: policy({ confirm: 'always' }) }))).toEqual({ kind: 'allow' });
    expect(decide(input({ tool: 'mark_read', recipient: family }))).toEqual({ kind: 'allow' });
  });
  it('refuses channels, broadcast lists and unknown kinds', () => {
    for (const target of [channel, broadcast, unknown]) {
      expect(decide(input({ recipient: target, policy: policy({ confirm: 'never' }) }))).toMatchObject({ kind: 'deny', code: 'unsupported_target' });
    }
  });
  it('gates groups behind writes.groups', () => {
    expect(decide(input({ recipient: family, policy: policy({ confirm: 'never' }) }))).toMatchObject({ kind: 'deny', code: 'groups_disabled' });
    expect(decide(input({ recipient: family, policy: policy({ confirm: 'never', groups: true }) }))).toEqual({ kind: 'allow' });
  });
  it('refuses files outside the roots', () => {
    expect(decide(input({ tool: 'send_file', fileInsideRoots: false, policy: policy({ confirm: 'never' }) }))).toMatchObject({ kind: 'deny', code: 'file_outside_roots' });
    expect(decide(input({ tool: 'send_file', fileInsideRoots: true, policy: policy({ confirm: 'never' }) }))).toEqual({ kind: 'allow' });
  });
  it('rate limits by window and by gap', () => {
    const p = policy({ confirm: 'never' });
    expect(decide(input({ policy: p, rate: { countLastHour: 20, secondsSinceLast: 600, secondsUntilWindowFrees: 1200 } })))
      .toMatchObject({ kind: 'deny', code: 'rate_limited', retryAfterSeconds: 1200 });
    expect(decide(input({ policy: p, rate: { countLastHour: 1, secondsSinceLast: 2, secondsUntilWindowFrees: 3598 } })))
      .toMatchObject({ kind: 'deny', code: 'rate_limited', retryAfterSeconds: 3 });
    expect(decide(input({ policy: p, rate: { countLastHour: 19, secondsSinceLast: 5, secondsUntilWindowFrees: 1 } }))).toEqual({ kind: 'allow' });
  });
  it('says "second" for one second and "seconds" for any other count in the retry hint', () => {
    const p = policy({ confirm: 'never' });
    const messageFor = (rate: DecideInput['rate']): string => {
      const d = decide(input({ policy: p, rate }));
      if (d.kind !== 'deny') throw new Error('expected a denial');
      return d.message;
    };
    const base = 'Send rate limit reached. Wait before sending again.';
    expect(messageFor({ countLastHour: 1, secondsSinceLast: 4, secondsUntilWindowFrees: 3000 })).toBe(`${base} Retry after 1 second.`);
    expect(messageFor({ countLastHour: 1, secondsSinceLast: 3, secondsUntilWindowFrees: 3000 })).toBe(`${base} Retry after 2 seconds.`);
    expect(messageFor({ countLastHour: 20, secondsSinceLast: 600, secondsUntilWindowFrees: 1 })).toBe(`${base} Retry after 1 second.`);
    expect(messageFor({ countLastHour: 20, secondsSinceLast: 600, secondsUntilWindowFrees: 0.2 })).toBe(`${base} Retry after 1 second.`);
    expect(messageFor({ countLastHour: 20, secondsSinceLast: 600, secondsUntilWindowFrees: 3600 })).toBe(`${base} Retry after 3600 seconds.`);
  });
  it('asks for confirmation in always mode and allows after acceptance', () => {
    expect(decide(input())).toEqual({ kind: 'confirm' });
    expect(decide(input({ answer: 'accepted' }))).toEqual({ kind: 'allow' });
    expect(decide(input({ answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'confirmation_declined' });
  });
  it('denies a declined answer even when the policy no longer asks for confirmation', () => {
    // The prompt was shown under one policy and declined; by the time the answer arrives the policy says never, or the person is allowlisted.
    expect(decide(input({ policy: policy({ confirm: 'never' }), answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'confirmation_declined' });
    expect(decide(input({ policy: policy({ confirm: 'unlisted', allow: ['+61 400 000 001'] }), answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'confirmation_declined' });
    expect(decide(input({ policy: policy({ confirm: 'never' }), answer: 'declined', clientCanConfirm: false }))).toMatchObject({ kind: 'deny', code: 'confirmation_declined' });
    expect(decide(input({ policy: policy({ confirm: 'never', groups: true }), recipient: family, answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'confirmation_declined' });
    expect(decide(input({ tool: 'send_file', fileInsideRoots: true, policy: policy({ confirm: 'never' }), answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'confirmation_declined' });
    expect(decide(input({ tool: 'react', policy: policy({ confirm: 'never' }), answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'confirmation_declined' });
  });

  it('still allows when no confirmation is needed and the answer is an accept or no answer', () => {
    expect(decide(input({ policy: policy({ confirm: 'never' }), answer: 'none' }))).toEqual({ kind: 'allow' });
    expect(decide(input({ policy: policy({ confirm: 'never' }), answer: 'accepted' }))).toEqual({ kind: 'allow' });
    expect(decide(input({ policy: policy({ confirm: 'unlisted', allow: ['+61 400 000 001'] }), answer: 'none' }))).toEqual({ kind: 'allow' });
  });

  it('keeps every earlier rule ahead of a declined answer, and never asks mark_read for one', () => {
    expect(decide(input({ policy: DEFAULT_POLICY, answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'writes_disabled' });
    expect(decide(input({ recipient: channel, policy: policy({ confirm: 'never' }), answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'unsupported_target' });
    expect(decide(input({ recipient: family, policy: policy({ confirm: 'never' }), answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'groups_disabled' });
    expect(decide(input({ tool: 'mark_read', policy: policy({ confirm: 'never' }), answer: 'declined' }))).toEqual({ kind: 'allow' });
  });

  it('skips confirmation for allowlisted recipients in unlisted mode', () => {
    expect(decide(input({ policy: policy({ confirm: 'unlisted', allow: ['+61 400 000 001'] }) }))).toEqual({ kind: 'allow' });
    expect(decide(input({ policy: policy({ confirm: 'unlisted', allow: ['+61 400 000 002'] }) }))).toEqual({ kind: 'confirm' });
  });
  it('denies when confirmation is needed but the client cannot show a form', () => {
    expect(decide(input({ clientCanConfirm: false }))).toMatchObject({ kind: 'deny', code: 'confirmation_unavailable' });
    expect(decide(input({ clientCanConfirm: false, policy: policy({ confirm: 'never' }) }))).toEqual({ kind: 'allow' });
  });
  it('re-checks earlier rules on re-entry', () => {
    expect(decide(input({ answer: 'accepted', rate: { countLastHour: 20, secondsSinceLast: 10, secondsUntilWindowFrees: 100 } }))).toMatchObject({ kind: 'deny', code: 'rate_limited' });
  });
});

describe('the hints in a denial', () => {
  it('ask the person to run the command, so an agent does not read them as instructions to itself', () => {
    const withCommand = Object.entries(DENY_MESSAGES).filter(([, m]) => m.includes('whatsapp-agent policy'));
    expect(withCommand.map(([code]) => code).sort()).toEqual(['confirmation_unavailable', 'file_outside_roots', 'groups_disabled', 'writes_disabled']);
    for (const [code, message] of withCommand) {
      expect(message, code).toContain('Ask the person to run: whatsapp-agent policy');
      expect(message, code).not.toMatch(/the person can|you can|run it yourself/i);
    }
  });

  it('keeps each command exactly as the person has to type it', () => {
    expect(DENY_MESSAGES.writes_disabled).toBe('Sending is turned off in the policy. Ask the person to run: whatsapp-agent policy enable');
    expect(DENY_MESSAGES.groups_disabled).toBe('Sending to groups is turned off. Ask the person to run: whatsapp-agent policy set groups on');
    expect(DENY_MESSAGES.file_outside_roots).toBe('That file is outside the allowed folders. Ask the person to run: whatsapp-agent policy add-file-root <dir>');
    expect(DENY_MESSAGES.confirmation_unavailable).toBe(
      'This send needs the person to confirm, but this client cannot show a confirmation form. Ask the person to run: whatsapp-agent policy allow <recipient>, then: whatsapp-agent policy set confirm unlisted',
    );
  });

  it('carry no hint at all where there is no command to run', () => {
    for (const code of ['unsupported_target', 'rate_limited', 'confirmation_declined'] as const) expect(DENY_MESSAGES[code]).not.toContain('whatsapp-agent');
  });

  it('reach the agent through the decision', () => {
    const d = decide(input({ policy: DEFAULT_POLICY }));
    expect(d).toMatchObject({ kind: 'deny', code: 'writes_disabled', message: expect.stringContaining('Ask the person to run: whatsapp-agent policy enable') });
  });
});

describe('file roots', () => {
  let tmp: string;
  beforeEach(async () => { tmp = await makeTmp(); });
  afterEach(async () => { await removeTmp(tmp); });

  it('isInsideRoot is a pure prefix check on path segments', () => {
    expect(isInsideRoot('/a/b/c.txt', '/a/b')).toBe(true);
    expect(isInsideRoot('/a/bc/c.txt', '/a/b')).toBe(false);
    expect(isInsideRoot('/a/b', '/a/b')).toBe(false);
  });

  it('isInsideRoot tells a file whose name starts with two dots from a path that leaves the root', () => {
    expect(isInsideRoot('/a/b/..notes.txt', '/a/b')).toBe(true);
    expect(isInsideRoot('/a/b/...hidden', '/a/b')).toBe(true);
    expect(isInsideRoot('/a/b/..d/c.txt', '/a/b')).toBe(true);
    expect(isInsideRoot('/a', '/a/b')).toBe(false);
    expect(isInsideRoot('/a/c.txt', '/a/b')).toBe(false);
    expect(isInsideRoot('/a/b/../c.txt', '/a/b')).toBe(false);
    expect(isInsideRoot('/other', '/a/b')).toBe(false);
  });

  it('accepts a file inside a root and rejects a symlink escaping the root', async () => {
    const root = path.join(tmp, 'root');
    const outside = path.join(tmp, 'outside');
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(root, 'ok.txt'), 'x');
    await writeFile(path.join(outside, 'secret.txt'), 'y');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    expect(await fileInsideRoots(path.join(root, 'ok.txt'), [root])).toBe(true);
    expect(await fileInsideRoots(path.join(root, 'link.txt'), [root])).toBe(false);
    expect(await fileInsideRoots(path.join(outside, 'secret.txt'), [root])).toBe(false);
    expect(await fileInsideRoots(path.join(root, 'ok.txt'), [])).toBe(false);
    expect(await fileInsideRoots(path.join(root, 'ok.txt'), [path.join(tmp, 'missing'), root])).toBe(true);
    expect(await fileInsideRoots(path.join(root, 'absent.txt'), [root])).toBe(false);
  });

  it('accepts a file inside a root whose name starts with two dots', async () => {
    const root = path.join(tmp, 'root');
    await mkdir(root);
    await writeFile(path.join(root, '..notes.txt'), 'x');
    expect(await fileInsideRoots(path.join(root, '..notes.txt'), [root])).toBe(true);
  });
});
