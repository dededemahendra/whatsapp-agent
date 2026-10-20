import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureStderr } from '../helpers/stderr.js';

const saved = process.env.WHATSAPP_AGENT_LOG;
afterEach(() => {
  if (saved === undefined) delete process.env.WHATSAPP_AGENT_LOG;
  else process.env.WHATSAPP_AGENT_LOG = saved;
  vi.restoreAllMocks();
  vi.resetModules();
});

/** The logger as it is when the process starts with this value of WHATSAPP_AGENT_LOG (the flag is read once, at import). */
async function loggerWith(flag: string | undefined): Promise<typeof import('../../src/log.js')> {
  if (flag === undefined) delete process.env.WHATSAPP_AGENT_LOG;
  else process.env.WHATSAPP_AGENT_LOG = flag;
  vi.resetModules();
  return import('../../src/log.js');
}

describe('warn', () => {
  it.each([undefined, '', 'debug', 'warn', 'off', '0', 'DEBUG'])('writes one line to stderr when WHATSAPP_AGENT_LOG is %j', async (flag) => {
    const { warn } = await loggerWith(flag);
    const err = captureStderr();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    warn('Could not write the audit log at /x/audit.jsonl: ENOSPC', { tool: 'send_text', outcome: 'sent' });
    expect(err.text()).toBe('[whatsapp-agent] Could not write the audit log at /x/audit.jsonl: ENOSPC {"tool":"send_text","outcome":"sent"}\n');
    expect(out).not.toHaveBeenCalled();
  });

  it('leaves the suffix off a line that has no data', async () => {
    const { warn } = await loggerWith(undefined);
    const err = captureStderr();
    warn('Something to know');
    expect(err.text()).toBe('[whatsapp-agent] Something to know\n');
  });

  it('has the shape of a debug line, so the two read alike in one log', async () => {
    const { warn, debug } = await loggerWith('debug');
    const err = captureStderr();
    debug('same words', { a: 1 });
    warn('same words', { a: 1 });
    const [first, second] = err.lines();
    expect(first).toBe(second);
    expect(first).toBe('[whatsapp-agent] same words {"a":1}');
  });

  it('never throws, so a log line cannot turn a delivered send into a failure', async () => {
    const { warn, debug } = await loggerWith('debug');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => warn('circular data', circular)).not.toThrow();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => { throw new Error('EPIPE: broken pipe'); });
    expect(() => warn('stderr is gone', { a: 1 })).not.toThrow();
    expect(() => debug('stderr is gone', { a: 1 })).not.toThrow();
  });
});

describe('debug', () => {
  it('stays silent unless WHATSAPP_AGENT_LOG is debug', async () => {
    for (const flag of [undefined, '', 'warn', 'DEBUG', '1']) {
      const { debug } = await loggerWith(flag);
      const err = captureStderr();
      debug('hidden', { a: 1 });
      expect(err.text(), String(flag)).toBe('');
      vi.restoreAllMocks();
    }
  });

  it('writes its line when WHATSAPP_AGENT_LOG is debug', async () => {
    const { debug } = await loggerWith('debug');
    const err = captureStderr();
    debug('shown', { a: 1 });
    expect(err.text()).toBe('[whatsapp-agent] shown {"a":1}\n');
  });
});
