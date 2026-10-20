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
});
