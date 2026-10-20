import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildSyncArgs, describeStderrLine, parseEventLine, startSupervisor } from '../../src/ops/daemon.js';
import { DEFAULT_POLICY } from '../../src/policy/schema.js';
import { FAKE_WACLI, fakeEnv, makeTmp, removeTmp } from '../helpers/fake.js';

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

  it('forwards non-JSON stderr lines to the log', async () => {
    const { handle, lines } = start('text;sleep:30000');
    await new Promise((r) => setTimeout(r, 400));
    await handle.stop();
    await handle.done;
    expect(lines.some((l) => l.endsWith('connected; history sync 12%'))).toBe(true);
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
