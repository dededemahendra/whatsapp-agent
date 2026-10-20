import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSyncArgs, describeStderrLine, parseEventLine, startSupervisor } from '../../src/ops/daemon.js';
import { DEFAULT_POLICY } from '../../src/policy/schema.js';
import { FAKE_WACLI, fakeEnv, makeTmp, removeTmp } from '../helpers/fake.js';
import { waitFor } from '../helpers/wait.js';

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

describe('buildSyncArgs', () => {
  it('builds the follow command from the policy', () => {
    expect(buildSyncArgs(null, DEFAULT_POLICY.daemon)).toEqual([
      'sync', '--follow', '--presence-mode=quiet', '--send-spacing=2s-6s', '--stale-threshold=2m', '--max-reconnect=0',
      '--max-db-size=2GB', '--refresh-contacts', '--refresh-groups', '--events',
    ]);
    expect(buildSyncArgs('work', { ...DEFAULT_POLICY.daemon, downloadMedia: true }).slice(0, 2)).toEqual(['--account', 'work']);
    expect(buildSyncArgs('work', { ...DEFAULT_POLICY.daemon, downloadMedia: true })).toContain('--download-media');
  });
});

describe('parseEventLine', () => {
  it('parses NDJSON events and ignores other lines', () => {
    expect(parseEventLine('{"event":"connected","data":{},"ts":1}')).toEqual({ event: 'connected', data: {} });
    expect(parseEventLine('connected; history sync 12%')).toBeNull();
    expect(parseEventLine('{"nope":1}')).toBeNull();
  });
});

describe('startSupervisor', () => {
  function start(script: string, over: { sleeps?: number[]; sleep?: (ms: number) => Promise<void> } = {}) {
    const lines: string[] = [];
    const sleeps: number[] = over.sleeps ?? [];
    const handle = startSupervisor({
      bin: FAKE_WACLI,
      account: null,
      daemon: DEFAULT_POLICY.daemon,
      env: fakeEnv({ FAKE_WACLI_SYNC: script, FAKE_WACLI_SYNC_COUNTER: path.join(tmp, 'counter') }),
      log: (l) => lines.push(l),
      backoff: { initialMs: 50, maxMs: 200, resetAfterMs: 60_000 },
      sleep: over.sleep ?? (async (ms) => { sleeps.push(ms); }),
    });
    return { handle, lines, sleeps };
  }

  it('logged_out stops the loop and resolves', async () => {
    const { handle, lines, sleeps } = start('connected;logged_out;exit:0');
    await expect(handle.done).resolves.toBe('logged_out');
    expect(sleeps).toEqual([]);
    expect(lines.some((l) => l.includes('event=connected'))).toBe(true);
    expect(lines.some((l) => l.includes('whatsapp-agent setup'))).toBe(true);
  });

  it('crash restarts with backoff, doubling to the cap, then stop() ends it', async () => {
    const { handle, sleeps, lines } = start('connected;crash|crash|crash|crash|connected;sleep:30000');
    await new Promise((r) => setTimeout(r, 3000));
    expect(sleeps).toEqual([50, 100, 200, 200]);
    await handle.stop();
    await expect(handle.done).resolves.toBe('stopped');
    expect(lines.some((l) => l.includes('restarting in 50 ms'))).toBe(true);
  });

  it('stop() interrupts a backoff sleep', async () => {
    const { handle } = start('crash', { sleep: () => new Promise(() => {}) });
    await new Promise((r) => setTimeout(r, 400));
    await handle.stop();
    await expect(handle.done).resolves.toBe('stopped');
  });

  it('logs an error event with its message sanitised', async () => {
    const { handle, lines } = start('connected;error:send failed for 61400000001@s.whatsapp.net;sleep:30000');
    await waitFor(() => lines.some((l) => l.endsWith('error: send failed for <jid>')), { what: 'the error event in the log' });
    await handle.stop();
    await handle.done;
    expect(lines.join('\n')).not.toContain('61400000001');
  });

  it('forwards non-JSON stderr lines to the log', async () => {
    const { handle, lines } = start('text;sleep:30000');
    await new Promise((r) => setTimeout(r, 400));
    await handle.stop();
    await handle.done;
    expect(lines.some((l) => l.endsWith('connected; history sync 12%'))).toBe(true);
  });
});

describe('describeStderrLine structured lines', () => {
  const errorEvent = (message: unknown) => JSON.stringify({ event: 'error', data: { message }, ts: 1 });

  it('logs the sanitised message of an error event', () => {
    expect(describeStderrLine(errorEvent('send failed: context deadline exceeded'))).toEqual({ text: 'error: send failed: context deadline exceeded', event: 'error' });
  });

  it('strips controls, replaces JIDs and runs of 8 or more digits, and caps the message at 200 characters', () => {
    const raw = 'bad\u001b[31m for 61400000001@s.whatsapp.net and 120363000000000001@g.us:\u0007 call 0412345678 or 12345, id 61400000001:12@s.whatsapp.net';
    expect(describeStderrLine(errorEvent(raw)).text).toBe('error: bad[31m for <jid> and <jid>: call <number> or 12345, id <jid>');
    expect(describeStderrLine(errorEvent('x'.repeat(300))).text).toBe(`error: ${'x'.repeat(200)}`);
    expect(describeStderrLine(errorEvent(`${'y'.repeat(190)} 61400000001@s.whatsapp.net`)).text).toBe(`error: ${'y'.repeat(190)} <jid>`);
  });

  it('falls back to the event name when an error event has no usable message', () => {
    for (const data of [{}, { message: 42 }, { message: '' }, { message: '\u0007' }, null]) {
      expect(describeStderrLine(JSON.stringify({ event: 'error', data, ts: 1 }))).toEqual({ text: 'event=error', event: 'error' });
    }
  });

  it('keeps every other recognised event name-only, even when it carries a message', () => {
    expect(describeStderrLine('{"event":"disconnected","data":{"message":"secret words"},"ts":1}')).toEqual({ text: 'event=disconnected', event: 'disconnected' });
  });

  it('logs a wacli failure envelope as a capped, sanitised error', () => {
    const line = '{"success":false,"data":null,"error":"send text: usync failed for 61400000001@s.whatsapp.net\\u0007"}';
    expect(describeStderrLine(line)).toEqual({ text: 'wacli error: send text: usync failed for <jid>', event: null });
    expect(describeStderrLine(JSON.stringify({ success: false, data: null, error: 'z'.repeat(500) })).text).toBe(`wacli error: ${'z'.repeat(200)}`);
  });

  it('treats a success envelope, a failure without a string error, and other structured lines as placeholders', () => {
    const placeholder = (line: string) => `(unrecognised json line, ${line.length} chars)`;
    for (const line of [
      '{"success":true,"data":{"Text":"secret"},"error":null}',
      '{"success":false,"data":null,"error":{"code":5}}',
      '[{"Text":"secret"}]',
      '"secret words"',
      '  ["secret words"]',
      '2026/10/20 10:00:00 payload {"Text":"secret"}',
    ]) {
      expect(describeStderrLine(line).text).toBe(placeholder(line));
    }
  });

  it('still logs plain lines, including ones with quotes that are not JSON', () => {
    expect(describeStderrLine('connected; history sync 12%').text).toBe('connected; history sync 12%');
    expect(describeStderrLine('time=1 msg="history sync" pct=12').text).toBe('time=1 msg="history sync" pct=12');
  });
});

describe('describeStderrLine', () => {
  it('logs event names only, redacts other json, strips control characters and caps length', () => {
    expect(describeStderrLine('{"event":"connected","data":{"Text":"secret"},"ts":1}')).toEqual({ text: 'event=connected', event: 'connected' });
    expect(describeStderrLine('{"event":"bad\\nname","ts":1}')).toEqual({ text: 'event=(unrecognised name)', event: null });
    expect(describeStderrLine('{"type":"message","Text":"secret"}').text).toBe('(unrecognised json line, 34 chars)');
    expect(describeStderrLine('warn \u001b[31mred\u001b[0m').text).toBe('warn [31mred[0m');
    expect(describeStderrLine('x'.repeat(600)).text).toBe(`${'x'.repeat(500)}... (600 chars)`);
    expect(describeStderrLine('   ').text).toBeNull();
  });
});
