import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentError } from '../../src/errors.js';
import { classifyFailure, classifyMessage, createRunner, parseEnvelope } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, makeTmp, readArgvLog, removeTmp } from '../helpers/fake.js';

let tmp: string;
let log: string;
beforeEach(async () => { tmp = await makeTmp(); log = path.join(tmp, 'argv.log'); });
afterEach(async () => { await removeTmp(tmp); });

function runner(extra: Record<string, string> = {}, account: string | null = null) {
  return createRunner({ bin: FAKE_WACLI, account, baseEnv: fakeEnv({ FAKE_WACLI_LOG: log, ...extra }) });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { if (e instanceof AgentError) return e.code; throw e; }
  throw new Error('expected rejection');
}

describe('createRunner against the fake wacli', () => {
  it('read adds --json, --timeout, --read-only and WACLI_READONLY=1', async () => {
    const data = await runner().read<unknown[]>(['chats', 'list', '--limit=5']);
    expect(data).toHaveLength(2);
    const [rec] = await readArgvLog(log);
    expect(rec!.argv).toEqual(['--json', '--timeout', '25s', '--read-only', 'chats', 'list', '--limit=5']);
    expect(rec!.env.WACLI_READONLY).toBe('1');
    expect(rec!.env.NO_COLOR).toBe('1');
  });

  it('write adds --json and --timeout only', async () => {
    await runner().write(['send', 'text', '--to=x@s.whatsapp.net', '--message=hi']);
    const [rec] = await readArgvLog(log);
    expect(rec!.argv).toEqual(['--json', '--timeout', '85s', 'send', 'text', '--to=x@s.whatsapp.net', '--message=hi']);
    expect(rec!.env.WACLI_READONLY).toBeUndefined();
  });

  it('isolates WACLI_READONLY per mode even when the parent env sets it', async () => {
    const r = createRunner({ bin: FAKE_WACLI, baseEnv: { ...fakeEnv({ FAKE_WACLI_LOG: log }), WACLI_READONLY: '1' } });
    await r.write(['send', 'text', '--to=x@s.whatsapp.net', '--message=hi']);
    await r.read(['doctor'], { env: { WACLI_READONLY: '0' } });
    const recs = await readArgvLog(log);
    expect(recs[0]!.env.WACLI_READONLY).toBeUndefined();
    expect(recs[1]!.env.WACLI_READONLY).toBe('1');
  });

  it('marks a failed write as outcome-uncertain and leaves reads alone', async () => {
    const failing = runner({ FAKE_WACLI_FAIL: '*|1|connection reset by peer' });
    await expect(failing.write(['send', 'text', '--to=x@s.whatsapp.net', '--message=hi'])).rejects.toMatchObject({
      code: 'wacli_error',
      message: expect.stringContaining('may have gone through'),
      details: expect.objectContaining({ outcome_uncertain: true }),
    });
    await expect(failing.read(['doctor'])).rejects.toMatchObject({
      code: 'wacli_error',
      message: expect.not.stringContaining('may have gone through'),
    });
  });

  it('marks a write whose envelope reports failure as outcome-uncertain', async () => {
    const dir = path.join(tmp, 'fixtures');
    await mkdir(dir);
    await writeFile(path.join(dir, 'send_text.json'), '{"success":false,"data":null,"error":"stale session"}\n');
    await expect(runner({ FAKE_WACLI_FIXTURES: dir }).write(['send', 'text', '--to=x@s.whatsapp.net', '--message=hi'])).rejects.toMatchObject({
      code: 'wacli_error',
      message: expect.stringContaining('stale session. The outcome is uncertain'),
      details: expect.objectContaining({ outcome_uncertain: true }),
    });
  });

  it('prefixes --account when configured', async () => {
    await runner({}, 'work').read(['doctor']);
    const [rec] = await readArgvLog(log);
    expect(rec!.argv.slice(0, 2)).toEqual(['--account', 'work']);
  });

  it('classifies not authenticated from stderr envelope', async () => {
    const p = runner({ FAKE_WACLI_FAIL: 'chats list|1|not authenticated; run `wacli auth`' }).read(['chats', 'list']);
    await expect(p).rejects.toMatchObject({ code: 'not_authenticated', message: expect.stringContaining('whatsapp-agent setup') });
  });

  it('classifies a locked store, a revoked session and a generic failure', async () => {
    expect(await codeOf(runner({ FAKE_WACLI_FAIL: '*|1|store is locked (another wacli is running?): locked' }).read(['doctor']))).toBe('store_locked');
    expect(await codeOf(runner({ FAKE_WACLI_FAIL: '*|1|WhatsApp session was revoked: 401' }).read(['doctor']))).toBe('session_logged_out');
    const p = runner({ FAKE_WACLI_FAIL: '*|1|something odd happened' }).read(['doctor']);
    await expect(p).rejects.toMatchObject({ code: 'wacli_error', message: 'something odd happened', details: { stderr_tail: expect.stringContaining('something odd') } });
  });

  it('reports a missing binary', async () => {
    const r = createRunner({ bin: path.join(tmp, 'missing-wacli'), baseEnv: fakeEnv() });
    expect(await codeOf(r.read(['doctor']))).toBe('wacli_not_installed');
  });

  it('times out and says a send may have gone through', async () => {
    const p = runner({ FAKE_WACLI_SLEEP_MS: '1500' }).read(['doctor'], { timeoutMs: 300 });
    await expect(p).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('may have gone through') });
  });

  it('rejects oversized output', async () => {
    const p = runner({ FAKE_WACLI_BIG: '1' }).read(['doctor']);
    await expect(p).rejects.toMatchObject({ code: 'wacli_error', message: expect.stringContaining('16 MiB') });
  });

  it('parses the version from plain text', async () => {
    expect(await runner().version()).toBe('0.22.0');
    expect(await runner({ FAKE_WACLI_VERSION: 'wacli v0.23.1 (darwin/arm64)' }).version()).toBe('0.23.1');
  });
});

describe('pure helpers', () => {
  it('parseEnvelope returns data and rejects non-JSON', () => {
    expect(parseEnvelope<{ a: number }>('{"success":true,"data":{"a":1},"error":null}\n', '')).toEqual({ a: 1 });
    expect(() => parseEnvelope('not json', 'warn')).toThrow(AgentError);
  });

  it('parseEnvelope maps a failed envelope on stdout too', () => {
    expect(() => parseEnvelope('{"success":false,"data":null,"error":"not authenticated; run `wacli auth`"}', '')).toThrowError(expect.objectContaining({ code: 'not_authenticated' }));
  });

  it('parseEnvelope accepts a pretty-printed multi-line envelope', () => {
    expect(parseEnvelope<number[]>('{\n  "success": true,\n  "data": [1, 2],\n  "error": null\n}\n', '')).toEqual([1, 2]);
  });

  it('classifyFailure prefers the stderr envelope and falls back to the exit code', () => {
    expect(classifyFailure(1, '', '{"success":false,"data":null,"error":"store is locked (another wacli is running?)"}').code).toBe('store_locked');
    expect(classifyFailure(3, '', '').message).toBe('wacli exited with code 3');
  });

  it('classifyMessage maps not found', () => {
    expect(classifyMessage('message not found').code).toBe('not_found');
  });

  it('classifyMessage maps wacli deadline wording to timeout and keeps lock waits as store_locked', () => {
    const e = classifyMessage('send text: context deadline exceeded');
    expect(e.code).toBe('timeout');
    expect(e.message).toContain('may have gone through');
    expect(classifyMessage('timed out waiting for store lock after 5s').code).toBe('store_locked');
  });
});

describe('a wacli older than the minimum', () => {
  const TOO_OLD = 'wacli is older than the minimum 0.22.0. Upgrade with: brew upgrade wacli';
  const USAGE = 'Error: unknown flag: --read-only\nUsage:\n  wacli <cmd> [flags]\n';

  it('maps the unknown flag errors of an old wacli to wacli_too_old and keeps the stderr tail', () => {
    for (const flag of ['--read-only', '--account', '--timeout']) {
      const e = classifyMessage(`unknown flag: ${flag}`);
      expect(e.code).toBe('wacli_too_old');
      expect(e.message).toBe(TOO_OLD);
    }
    expect(classifyMessage('unknown flag: --read-only', USAGE).details).toEqual({ stderr_tail: USAGE });
  });

  it('finds the unknown flag in a plain stderr text whose last line is usage help', () => {
    expect(classifyFailure(1, '', USAGE)).toMatchObject({ code: 'wacli_too_old', message: TOO_OLD, details: { stderr_tail: USAGE } });
  });

  it('flags an old wacli end to end through the fake, and does not call a rejected write uncertain', async () => {
    const old = { FAKE_WACLI_VERSION: '0.21.0' };
    await expect(runner(old).read(['doctor'])).rejects.toMatchObject({
      code: 'wacli_too_old',
      message: TOO_OLD,
      details: { stderr_tail: expect.stringContaining('unknown flag: --read-only') },
    });
    const err = await runner(old, 'work').write(['send', 'text', '--to=x@s.whatsapp.net', '--message=hi']).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'wacli_too_old', details: { stderr_tail: expect.stringContaining('unknown flag: --account') } });
    expect((err as AgentError).details.outcome_uncertain).toBeUndefined();
    expect((err as AgentError).message).toBe(TOO_OLD);
  });

  it('still reads and writes when the fake is at the minimum or newer', async () => {
    await expect(runner({ FAKE_WACLI_VERSION: '0.22.0' }).read(['doctor'])).resolves.toBeDefined();
    await expect(runner({ FAKE_WACLI_VERSION: '0.23.1' }, 'work').read(['doctor'])).resolves.toBeDefined();
  });
});

describe('classification looks at the whole text', () => {
  it('matches a keyword on any line of the stderr text, not only the last', () => {
    expect(classifyFailure(1, '', 'store is locked by another process\nexit status 1\n').code).toBe('store_locked');
  });

  it('finds the failure envelope when it is not the last stderr line', () => {
    const stderr = '{"success":false,"data":null,"error":"not authenticated; run `wacli auth`"}\nUsage: wacli auth\n';
    expect(classifyFailure(1, '', stderr).code).toBe('not_authenticated');
  });

  it('finds the failure envelope when noise follows it on stderr', () => {
    const stderr = 'warning: repeated send within 5 seconds\n{"success":false,"data":null,"error":"chat not found"}\nexit status 1\n';
    expect(classifyFailure(1, '', stderr).code).toBe('not_found');
  });

  it('parseEnvelope finds the envelope on any line, from the last backwards', () => {
    expect(parseEnvelope('log line\n{"success":true,"data":{"a":1},"error":null}\ntrailing log\n', '')).toEqual({ a: 1 });
    expect(() => parseEnvelope('log line\n{"success":false,"data":null,"error":"chat not found"}\ntrailing log\n', '')).toThrowError(expect.objectContaining({ code: 'not_found' }));
  });
});
