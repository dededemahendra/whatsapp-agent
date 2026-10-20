import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGracefulStop, logStdioError } from '../../src/mcp/stdio.js';
import { drainInFlight } from '../../src/mcp/tools/send.js';
import type { Policy } from '../../src/policy/schema.js';
import { waitFor, within } from '../helpers/wait.js';
import { errorOf, makeHarness, stubWrite, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => { await h?.close(); });

const enabled = (over: Partial<Policy['writes']> = {}) => (p: Policy): Policy => ({ ...p, writes: { ...p.writes, enabled: true, confirm: 'never', rateLimit: { perHour: 20, minGapSeconds: 0 }, ...over } });
const SENT = { sent: true, to: '61400000001@s.whatsapp.net', id: 'BLOCKED0001' };

/** A write that waits until the test lets it go, and says when it began. */
function blockedWrites(h: Harness): { started: () => number; releaseAll: () => void; failAll: (e: Error) => void } {
  const waiting: Array<{ ok: () => void; fail: (e: Error) => void }> = [];
  let count = 0;
  stubWrite(h, () => {
    count += 1;
    return new Promise((resolve, reject) => { waiting.push({ ok: () => resolve(SENT), fail: reject }); });
  });
  return { started: () => count, releaseAll: () => waiting.forEach((w) => w.ok()), failAll: (e) => waiting.forEach((w) => w.fail(e)) };
}

describe('drainInFlight', () => {
  it('resolves at once when nothing is being written', async () => {
    const t0 = Date.now();
    await drainInFlight(2000);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('waits for a write that is past the gate, and for the audit row that ends it', async () => {
    h = await makeHarness({ policy: enabled() });
    const writes = blockedWrites(h);
    const call = h.call('send_text', { to: 'Alice', message: 'hello' });
    await waitFor(() => writes.started() === 1, { what: 'the write to begin' });

    let drained = false;
    const drain = drainInFlight(10_000).then(() => { drained = true; });
    await new Promise((r) => setTimeout(r, 150));
    expect(drained).toBe(false);

    writes.releaseAll();
    await within(drain, 5000, 'the drain');
    expect(h.audits.at(-1)).toMatchObject({ tool: 'send_text', outcome: 'sent', message_id: 'BLOCKED0001' });
    expect((await call).isError).toBeFalsy();
  });

  it('gives up at the deadline when a write never finishes', async () => {
    h = await makeHarness({ policy: enabled() });
    const writes = blockedWrites(h);
    const call = h.call('send_text', { to: 'Alice', message: 'hello' });
    await waitFor(() => writes.started() === 1, { what: 'the write to begin' });

    const t0 = Date.now();
    await within(drainInFlight(120), 5000, 'the drain deadline');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(100);
    expect(h.audits.some((a) => a.outcome === 'sent')).toBe(false);

    writes.releaseAll();
    await call;
  });

  it('waits for every write in flight, not just the first', async () => {
    h = await makeHarness({ policy: enabled() });
    const writes = blockedWrites(h);
    const calls = [h.call('send_text', { to: 'Alice', message: 'one' }), h.call('send_text', { to: 'Alice', message: 'two' })];
    await waitFor(() => writes.started() === 2, { what: 'both writes to begin' });

    let drained = false;
    const drain = drainInFlight(10_000).then(() => { drained = true; });
    writes.releaseAll();
    await within(drain, 5000, 'the drain');
    expect(drained).toBe(true);
    expect(h.audits.filter((a) => a.outcome === 'sent')).toHaveLength(2);
    await Promise.all(calls);
  });

  it('is released when the write fails, and the failed row is written first', async () => {
    h = await makeHarness({ policy: enabled() });
    const writes = blockedWrites(h);
    const call = h.call('send_text', { to: 'Alice', message: 'hello' });
    await waitFor(() => writes.started() === 1, { what: 'the write to begin' });
    const drain = drainInFlight(10_000);
    writes.failAll(new Error('connection reset'));
    await within(drain, 5000, 'the drain');
    expect(h.audits.at(-1)).toMatchObject({ tool: 'send_text', outcome: 'failed' });
    expect((await call).isError).toBe(true);
  });

  it('does not count a denied call, a call waiting on a confirmation, or a call that failed before the write', async () => {
    const quick = async (): Promise<number> => {
      const t0 = Date.now();
      await drainInFlight(1500);
      return Date.now() - t0;
    };
    h = await makeHarness({ policy: enabled({ enabled: false }) });
    expect(errorOf(await h.call('send_text', { to: 'Alice', message: 'x' })).error).toBe('writes_disabled');
    expect(await quick()).toBeLessThan(700);
    await h.close();

    let during = -1;
    h = await makeHarness({
      policy: enabled({ confirm: 'always' }),
      elicit: () => {
        void quick().then((ms) => { during = ms; });
        return { action: 'decline' };
      },
    });
    expect(errorOf(await h.call('send_text', { to: 'Alice', message: 'x' })).error).toBe('confirmation_declined');
    await waitFor(() => during >= 0, { what: 'the drain taken during the prompt' });
    expect(during).toBeLessThan(700);
    await h.close();

    h = await makeHarness({ policy: enabled() });
    expect(errorOf(await h.call('send_text', { to: 'a', message: 'x' })).error).toBe('ambiguous_recipient');
    expect(await quick()).toBeLessThan(700);
  });
});

describe('graceful stop', () => {
  /** The pieces installGracefulStop reaches out to, replaced by recorders the test drives by hand. */
  function rig() {
    const listeners = new Map<string, () => void>();
    const registrations: string[] = [];
    const events: string[] = [];
    const exits: number[] = [];
    let finishClose!: () => void;
    let finishDrain!: () => void;
    const drainCalls: number[] = [];
    const handle = {
      close: vi.fn(() => { events.push('close'); return new Promise<void>((r) => { finishClose = r; }); }),
    };
    const hooks = {
      on: (signal: NodeJS.Signals, listener: () => void) => { registrations.push(signal); listeners.set(signal, listener); },
      exit: (code: number) => { events.push(`exit ${code}`); exits.push(code); },
      drain: (ms: number) => { events.push('drain'); drainCalls.push(ms); return new Promise<void>((r) => { finishDrain = r; }); },
    };
    return { listeners, registrations, events, exits, drainCalls, handle, hooks, closeDone: () => finishClose(), drainDone: () => finishDrain() };
  }

  it('listens for SIGINT, SIGTERM and SIGHUP, once each', () => {
    const r = rig();
    installGracefulStop(r.handle, r.hooks);
    expect([...r.registrations].sort()).toEqual(['SIGHUP', 'SIGINT', 'SIGTERM']);
  });

  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('on %s closes the transport, then drains for 10 seconds, then exits 0', async (signal) => {
    const r = rig();
    installGracefulStop(r.handle, r.hooks);
    r.listeners.get(signal)!();
    await waitFor(() => r.events.includes('close'), { what: 'close' });
    expect(r.events).toEqual(['close']);
    r.closeDone();
    await waitFor(() => r.events.includes('drain'), { what: 'drain' });
    expect(r.events).toEqual(['close', 'drain']);
    expect(r.drainCalls).toEqual([10_000]);
    r.drainDone();
    await waitFor(() => r.exits.length > 0, { what: 'exit' });
    expect(r.events).toEqual(['close', 'drain', 'exit 0']);
  });

  it('exits 130 at once on a second signal, and does not exit twice', async () => {
    const r = rig();
    installGracefulStop(r.handle, r.hooks);
    r.listeners.get('SIGTERM')!();
    await waitFor(() => r.events.includes('close'), { what: 'close' });
    r.listeners.get('SIGINT')!();
    expect(r.exits).toEqual([130]);
    r.closeDone();
    await waitFor(() => r.events.includes('drain'), { what: 'drain' });
    r.drainDone();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.exits).toEqual([130]);
    expect(r.handle.close).toHaveBeenCalledTimes(1);
  });

  it('still drains and exits 0 when closing the transport fails', async () => {
    const r = rig();
    r.handle.close.mockImplementation(() => Promise.reject(new Error('already closed')));
    installGracefulStop(r.handle, r.hooks);
    r.listeners.get('SIGTERM')!();
    await waitFor(() => r.events.includes('drain'), { what: 'drain' });
    r.drainDone();
    await waitFor(() => r.exits.length > 0, { what: 'exit' });
    expect(r.exits).toEqual([0]);
  });
});

describe('the stdio error hook', () => {
  it('logs the error name and never its message', async () => {
    vi.stubEnv('WHATSAPP_AGENT_LOG', 'debug');
    vi.resetModules();
    const fresh = await import('../../src/mcp/stdio.js');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      fresh.logStdioError(new TypeError('secret message text from a chat'));
      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain('[whatsapp-agent] stdio {"error":"TypeError"}');
      expect(written).not.toContain('secret');
    } finally {
      stderr.mockRestore();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
    expect(typeof logStdioError).toBe('function');
  });
});
