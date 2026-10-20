import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decide, fileInsideRoots, isInsideRoot, matchesAllow, type DecideInput } from '../../src/policy/engine.js';
import { DEFAULT_POLICY, type Policy } from '../../src/policy/schema.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';

const alice = { jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' as const };
const family = { jid: '120363000000000001@g.us', name: 'Family', kind: 'group' as const };
const channel = { jid: '1@newsletter', name: 'News', kind: 'channel' as const };
const calm = { countLastHour: 0, secondsSinceLast: null, secondsUntilWindowFrees: 0 };

function policy(over: Partial<Policy['writes']> = {}): Policy {
  return { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true, ...over } };
}
function input(over: Partial<DecideInput> = {}): DecideInput {
  return { policy: policy(), tool: 'send_text', recipient: alice, rate: calm, clientCanConfirm: true, answer: 'none', ...over };
}

describe('matchesAllow', () => {
  it('matches by JID, formatted phone and case-insensitive name', () => {
    expect(matchesAllow(['61400000001@s.whatsapp.net'], alice)).toBe(true);
    expect(matchesAllow(['+61 400 000 001'], alice)).toBe(true);
    expect(matchesAllow(['alice'], alice)).toBe(true);
    expect(matchesAllow(['+61400000001@s.whatsapp.net'], alice)).toBe(true);
    expect(matchesAllow(['61400000001:7@s.whatsapp.net'], alice)).toBe(true);
    expect(matchesAllow(['+61 400 000 002', 'Bob'], alice)).toBe(false);
    expect(matchesAllow([], alice)).toBe(false);
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
  it('refuses channels', () => {
    expect(decide(input({ recipient: channel, policy: policy({ confirm: 'never' }) }))).toMatchObject({ kind: 'deny', code: 'unsupported_target' });
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
  it('asks for confirmation in always mode and allows after acceptance', () => {
    expect(decide(input())).toEqual({ kind: 'confirm' });
    expect(decide(input({ answer: 'accepted' }))).toEqual({ kind: 'allow' });
    expect(decide(input({ answer: 'declined' }))).toMatchObject({ kind: 'deny', code: 'confirmation_declined' });
  });
  it('skips confirmation for allowlisted recipients in unlisted mode', () => {
    expect(decide(input({ policy: policy({ confirm: 'unlisted', allow: ['Alice'] }) }))).toEqual({ kind: 'allow' });
    expect(decide(input({ policy: policy({ confirm: 'unlisted', allow: ['Bob'] }) }))).toEqual({ kind: 'confirm' });
  });
  it('denies when confirmation is needed but the client cannot show a form', () => {
    expect(decide(input({ clientCanConfirm: false }))).toMatchObject({ kind: 'deny', code: 'confirmation_unavailable' });
    expect(decide(input({ clientCanConfirm: false, policy: policy({ confirm: 'never' }) }))).toEqual({ kind: 'allow' });
  });
  it('re-checks earlier rules on re-entry', () => {
    expect(decide(input({ answer: 'accepted', rate: { countLastHour: 20, secondsSinceLast: 10, secondsUntilWindowFrees: 100 } }))).toMatchObject({ kind: 'deny', code: 'rate_limited' });
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
});
