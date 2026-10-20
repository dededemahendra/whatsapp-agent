import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../../src/errors.js';
import { realIo } from '../../src/ops/setup-cmd.js';
import { BAN_NOTICE, runSetup, type SetupIO } from '../../src/ops/setup.js';
import { resolvePaths } from '../../src/paths.js';
import { DEFAULT_POLICY, loadPolicy, savePolicy } from '../../src/policy/schema.js';
import { createRunner, type Runner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, fixturesWith, makeTmp, readArgvLog, removeTmp } from '../helpers/fake.js';

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

const fileExists = (f: string) => access(f).then(() => true, () => false);

/** `asked` and `looked` record every ask() and which() call; `onRun` sets the exit code of run() (default 0). */
function io(over: Partial<SetupIO> & { answers?: boolean[]; found?: string | null; onRun?: (cmd: string, args: string[]) => number } = {}) {
  const out: string[] = [];
  const runs: string[][] = [];
  const asked: string[] = [];
  const looked: string[] = [];
  const answers = over.answers ?? [];
  const base: SetupIO = {
    ask: async (q) => { asked.push(q); return answers.shift() ?? false; },
    print: (t) => out.push(t),
    which: async (bin) => { looked.push(bin); return over.found === undefined ? FAKE_WACLI : over.found; },
    run: async (cmd, args) => { runs.push([cmd, ...args]); return over.onRun ? over.onRun(cmd, args) : 0; },
    exists: fileExists,
  };
  return { io: { ...base, ...over }, out, runs, asked, looked };
}

function opts(extra: Record<string, string> = {}) {
  const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'c'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'd') }, tmp);
  const env = fakeEnv(extra);
  return { paths, env, makeRunner: (bin: string, account?: string) => createRunner({ bin, account, baseEnv: env }) };
}

/** Records the binary and account each runner is built for, and hands back `runner` when given (else a real one against the fake). */
function spy(o: ReturnType<typeof opts>, runner?: Runner) {
  const made: Array<{ bin: string; account: string | undefined }> = [];
  const makeRunner = (bin: string, account?: string): Runner => {
    made.push({ bin, account });
    return runner ?? o.makeRunner(bin, account);
  };
  return { made, makeRunner };
}

/** A wacli whose pairing state the test controls. `reads` records every read the setup makes. */
function stubWacli(paired = false) {
  const state = { paired };
  const reads: string[][] = [];
  const runner: Runner = {
    bin: 'stub-wacli',
    read: async <T>(args: string[]): Promise<T> => { reads.push(args); return { authenticated: state.paired } as unknown as T; },
    write: async () => { throw new Error('setup must not write through wacli'); },
    version: async () => '0.22.0',
  };
  const pairOnAuth = (_cmd: string, args: string[]): number => { if (args.includes('auth')) state.paired = true; return 0; };
  return { runner, state, reads, pairOnAuth };
}

const service = (calls: string[]) => ({
  install: async () => { calls.push('install'); return '/svc'; },
  uninstall: async () => {},
  status: async () => ({ installed: false, running: null, detail: 'not installed' }),
});

describe('runSetup', () => {
  it('stops when wacli is missing and the person declines the install', async () => {
    const t = io({ found: null, answers: [false] });
    const ok = await runSetup({ io: t.io, ...opts(), service: null, isGlobal: true, flags: {} });
    expect(ok).toBe(false);
    expect(t.out.join('\n')).toContain('brew install openclaw/tap/wacli');
    expect(t.runs).toEqual([]);
  });

  it('runs brew install when accepted, then continues', async () => {
    let found: string | null = null;
    const t = io({ answers: [true, false], which: async () => found });
    t.io.run = async (cmd, args) => { if (cmd === 'brew') found = FAKE_WACLI; return 0; };
    const ok = await runSetup({ io: t.io, ...opts(), service: null, isGlobal: true, flags: {} });
    expect(ok).toBe(true);
  });

  it('skips auth when paired, writes the default policy, installs the service and prints host config', async () => {
    const calls: string[] = [];
    const t = io({ answers: [true] });
    const o = opts();
    const ok = await runSetup({ io: t.io, ...o, service: service(calls), isGlobal: true, flags: {} });
    expect(ok).toBe(true);
    expect(t.runs.find((r) => r[1] === 'auth')).toBeUndefined();
    expect((await loadPolicy(o.paths.policyFile)).writes.enabled).toBe(false);
    expect(calls).toEqual(['install']);
    const text = t.out.join('\n');
    expect(text).toContain('claude mcp add --scope user');
    expect(text).toContain('whatsapp -- npx -y whatsapp-agent mcp');
    expect(text).toContain('--env WHATSAPP_AGENT_DATA_DIR=');
    expect(text).toContain('whatsapp-agent policy enable');
    expect(text).toContain('WhatsApp');
  });

  it('runs wacli auth when not paired and reports when pairing did not complete', async () => {
    const t = io({ answers: [false] });
    const dir = await fixturesWith({ 'auth_status.json': '{"success":true,"data":{"authenticated":false},"error":null}\n' });
    try {
      const ok = await runSetup({ io: t.io, ...opts({ FAKE_WACLI_FIXTURES: dir }), service: null, isGlobal: true, flags: {} });
      expect(t.runs).toEqual([[FAKE_WACLI, 'auth']]);
      expect(ok).toBe(false);
      expect(t.out.join('\n')).toContain('Pairing did not complete');
      expect(t.out.join('\n')).not.toContain('TypeError');
    } finally {
      await removeTmp(dir);
    }
  });

  it('tells a non-global install how to get the service, and honours --no-service', async () => {
    const calls: string[] = [];
    const t = io({});
    expect(await runSetup({ io: t.io, ...opts(), service: service(calls), isGlobal: false, flags: {} })).toBe(true);
    expect(calls).toEqual([]);
    expect(t.out.join('\n')).toContain('npm i -g whatsapp-agent');
    const t2 = io({});
    await runSetup({ io: t2.io, ...opts(), service: service(calls), isGlobal: true, flags: { service: false } });
    expect(calls).toEqual([]);
  });

  it('refuses an old wacli', async () => {
    const t = io({});
    expect(await runSetup({ io: t.io, ...opts({ FAKE_WACLI_VERSION: '0.21.0' }), service: null, isGlobal: true, flags: {} })).toBe(false);
    expect(t.out.join('\n')).toContain('0.22.0');
  });
});

describe('runSetup policy handling', () => {
  it('writes the default policy with mode 0600 on a fresh machine and says writes are off', async () => {
    const t = io({});
    const o = opts();
    expect(await runSetup({ io: t.io, ...o, service: null, isGlobal: true, flags: {} })).toBe(true);
    const written = JSON.parse(await readFile(o.paths.policyFile, 'utf8')) as typeof DEFAULT_POLICY;
    expect(written.writes.enabled).toBe(false);
    expect(written).toEqual(DEFAULT_POLICY);
    expect((await stat(o.paths.policyFile)).mode & 0o777).toBe(0o600);
    for (const dir of [o.paths.configDir, o.paths.dataDir, o.paths.mediaDir]) expect((await stat(dir)).mode & 0o777).toBe(0o700);
    const text = t.out.join('\n');
    expect(text).toContain(`Wrote default policy (writes off) to ${o.paths.policyFile}`);
    expect(text).toContain(BAN_NOTICE);
    expect(text).toContain('Write tools are off');
    expect(text).not.toContain('Write tools are on');
  });

  it('keeps an existing policy byte for byte and says writes are on when they are', async () => {
    const o = opts();
    await savePolicy(o.paths.policyFile, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true } });
    const before = await readFile(o.paths.policyFile, 'utf8');
    const t = io({});
    expect(await runSetup({ io: t.io, ...o, service: null, isGlobal: true, flags: {} })).toBe(true);
    expect(await readFile(o.paths.policyFile, 'utf8')).toBe(before);
    const text = t.out.join('\n');
    expect(text).toContain(`Keeping existing policy at ${o.paths.policyFile}`);
    expect(text).toContain('Write tools are on in your existing policy');
    expect(text).toContain('whatsapp-agent policy disable');
    expect(text).not.toContain('Write tools are off');
  });

  it('refuses an invalid policy file before building a runner, and leaves the file alone', async () => {
    const o = opts();
    await mkdir(o.paths.configDir, { recursive: true });
    await writeFile(o.paths.policyFile, '{"nope":1}');
    const s = spy(o);
    const t = io({});
    expect(await runSetup({ io: t.io, ...o, makeRunner: s.makeRunner, service: null, isGlobal: true, flags: {} })).toBe(false);
    expect(t.out.join('\n')).toContain(o.paths.policyFile);
    expect(s.made).toEqual([]);
    expect(t.runs).toEqual([]);
    expect(await readFile(o.paths.policyFile, 'utf8')).toBe('{"nope":1}');
  });

  it('reads auth status for the account named in the policy', async () => {
    const log = path.join(tmp, 'argv.log');
    const o = opts({ FAKE_WACLI_LOG: log });
    await savePolicy(o.paths.policyFile, { ...DEFAULT_POLICY, account: 'work' });
    const t = io({});
    expect(await runSetup({ io: t.io, ...o, service: null, isGlobal: true, flags: {} })).toBe(true);
    const status = (await readArgvLog(log)).find((r) => r.key === 'auth status');
    expect(status).toBeDefined();
    expect(status!.argv).toContain('--account');
    expect(status!.argv[status!.argv.indexOf('--account') + 1]).toBe('work');
  });

  it('passes the policy account to the runner and to the wacli auth handoff', async () => {
    const o = opts();
    await savePolicy(o.paths.policyFile, { ...DEFAULT_POLICY, account: 'work' });
    const w = stubWacli(false);
    const s = spy(o, w.runner);
    const t = io({ onRun: w.pairOnAuth });
    expect(await runSetup({ io: t.io, ...o, makeRunner: s.makeRunner, service: null, isGlobal: true, flags: {} })).toBe(true);
    expect(s.made).toEqual([{ bin: FAKE_WACLI, account: 'work' }]);
    expect(t.runs).toEqual([[FAKE_WACLI, '--account', 'work', 'auth']]);
  });
});

describe('runSetup pairing', () => {
  it('hands the terminal to wacli auth for a new user with no account, then carries on', async () => {
    const o = opts();
    const w = stubWacli(false);
    const s = spy(o, w.runner);
    const t = io({ onRun: w.pairOnAuth });
    expect(await runSetup({ io: t.io, ...o, makeRunner: s.makeRunner, service: null, isGlobal: true, flags: {} })).toBe(true);
    expect(s.made).toEqual([{ bin: FAKE_WACLI, account: undefined }]);
    expect(t.runs).toEqual([[FAKE_WACLI, 'auth']]);
    expect(w.reads).toEqual([['auth', 'status'], ['auth', 'status']]);
    const text = t.out.join('\n');
    expect(text).toContain('Link a device');
    expect(text).toContain('WhatsApp is paired.');
  });

  it('reports abandoned pairing and writes nothing', async () => {
    const o = opts();
    const w = stubWacli(false);
    const s = spy(o, w.runner);
    const t = io({});
    expect(await runSetup({ io: t.io, ...o, makeRunner: s.makeRunner, service: null, isGlobal: true, flags: {} })).toBe(false);
    expect(t.runs).toEqual([[FAKE_WACLI, 'auth']]);
    expect(t.out.join('\n')).toContain('Pairing did not complete');
    expect(await fileExists(o.paths.policyFile)).toBe(false);
  });

  it('stops without starting a pairing when the store is locked', async () => {
    const o = opts({ FAKE_WACLI_FAIL: 'auth status|1|store is locked by another process' });
    const t = io({});
    expect(await runSetup({ io: t.io, ...o, service: null, isGlobal: true, flags: {} })).toBe(false);
    expect(t.out.join('\n')).toContain('The wacli store is locked by another process');
    expect(t.runs).toEqual([]);
    expect(await fileExists(o.paths.policyFile)).toBe(false);
  });

  it('prints an unclassified auth status error and still offers the pairing', async () => {
    const t = io({});
    const ok = await runSetup({ io: t.io, ...opts({ FAKE_WACLI_FAIL: 'auth status|1|something odd' }), service: null, isGlobal: true, flags: {} });
    const text = t.out.join('\n');
    expect(text).toContain('something odd');
    expect(t.runs).toEqual([[FAKE_WACLI, 'auth']]);
    expect(ok).toBe(false);
    expect(text).toContain('Pairing did not complete');
  });
});

describe('runSetup pairing check outcomes', () => {
  /** A wacli whose every read fails with `error`, as when the binary vanishes between the version check and the pairing check. */
  function failingWacli(error: Error): Runner {
    return { bin: 'stub-wacli', read: async () => { throw error; }, write: async () => { throw new Error('setup must not write through wacli'); }, version: async () => '0.22.0' };
  }

  it('treats not authenticated as unpaired and silent, then goes on to the pairing handoff', async () => {
    const t = io({});
    const ok = await runSetup({ io: t.io, ...opts({ FAKE_WACLI_FAIL: 'auth status|1|not authenticated; run `wacli auth`' }), service: null, isGlobal: true, flags: {} });
    const text = t.out.join('\n');
    expect(t.runs).toEqual([[FAKE_WACLI, 'auth']]);
    expect(text).toContain('Link a device');
    expect(text).not.toContain('`whatsapp-agent setup`');
    expect(ok).toBe(false);
    expect(text).toContain('Pairing did not complete');
  });

  it('treats a timeout as fatal: it prints the reason and starts no pairing', async () => {
    const o = opts({ FAKE_WACLI_FAIL: 'auth status|1|context deadline exceeded' });
    const t = io({});
    expect(await runSetup({ io: t.io, ...o, service: null, isGlobal: true, flags: {} })).toBe(false);
    expect(t.out.join('\n')).toContain('wacli reported a timeout: context deadline exceeded');
    expect(t.runs).toEqual([]);
    expect(await fileExists(o.paths.policyFile)).toBe(false);
  });

  it('treats wacli not being installed as fatal: it prints the reason and starts no pairing', async () => {
    const o = opts();
    const s = spy(o, failingWacli(new AgentError('wacli_not_installed', 'wacli was not found at "wacli". Install it with: brew install openclaw/tap/wacli')));
    const t = io({});
    expect(await runSetup({ io: t.io, ...o, makeRunner: s.makeRunner, service: null, isGlobal: true, flags: {} })).toBe(false);
    expect(t.out.join('\n')).toContain('wacli was not found');
    expect(t.runs).toEqual([]);
    expect(await fileExists(o.paths.policyFile)).toBe(false);
  });
});

describe('runSetup finding and installing wacli', () => {
  it('prints the brew and go install lines and stops when the person declines', async () => {
    const t = io({ found: null, answers: [false] });
    const ok = await runSetup({ io: t.io, ...opts(), service: null, isGlobal: true, flags: {} });
    expect(ok).toBe(false);
    const text = t.out.join('\n');
    expect(text).toContain('brew install openclaw/tap/wacli');
    expect(text).toContain('go install -tags sqlite_fts5 github.com/openclaw/wacli/cmd/wacli@latest');
    expect(t.asked).toEqual(['Install wacli with Homebrew now?']);
    expect(t.runs).toEqual([]);
  });

  it('runs the Homebrew install without asking when --install-wacli is given, then carries on', async () => {
    let calls = 0;
    const t = io({ which: async () => (calls++ === 0 ? null : FAKE_WACLI) });
    const ok = await runSetup({ io: t.io, ...opts(), service: null, isGlobal: true, flags: { installWacli: true } });
    expect(ok).toBe(true);
    expect(t.runs).toEqual([['brew', 'install', 'openclaw/tap/wacli']]);
    expect(t.asked).toEqual([]);
    expect(t.out.join('\n')).toContain(`wacli 0.22.0 found at ${FAKE_WACLI}`);
  });

  it('reports a failed Homebrew install with its exit code and stops', async () => {
    const t = io({ found: null, onRun: () => 1 });
    const ok = await runSetup({ io: t.io, ...opts(), service: null, isGlobal: true, flags: { installWacli: true } });
    expect(ok).toBe(false);
    expect(t.runs).toEqual([['brew', 'install', 'openclaw/tap/wacli']]);
    const text = t.out.join('\n');
    expect(text).toContain('Homebrew install exited with code 1.');
    expect(text).toContain('Install wacli, then run whatsapp-agent setup again.');
  });

  it('says so, without offering Homebrew, when WHATSAPP_AGENT_WACLI_BIN is an absolute path with nothing there', async () => {
    const t = io({ exists: async () => false });
    const ok = await runSetup({ io: t.io, ...opts({ WHATSAPP_AGENT_WACLI_BIN: '/nowhere/wacli' }), service: null, isGlobal: true, flags: {} });
    expect(ok).toBe(false);
    const text = t.out.join('\n');
    expect(text).toContain('WHATSAPP_AGENT_WACLI_BIN is set to /nowhere/wacli but nothing is there.');
    expect(text).not.toContain('brew install');
    expect(t.asked).toEqual([]);
    expect(t.looked).toEqual([]);
    expect(t.runs).toEqual([]);
  });

  it('uses an absolute WHATSAPP_AGENT_WACLI_BIN directly, without looking on the PATH', async () => {
    const t = io({});
    const ok = await runSetup({ io: t.io, ...opts({ WHATSAPP_AGENT_WACLI_BIN: FAKE_WACLI }), service: null, isGlobal: true, flags: {} });
    expect(ok).toBe(true);
    expect(t.looked).toEqual([]);
    expect(t.out.join('\n')).toContain(`wacli 0.22.0 found at ${FAKE_WACLI}`);
  });

  it('reports a wacli whose version cannot be read, instead of calling it too old', async () => {
    const t = io({});
    const ok = await runSetup({ io: t.io, ...opts({ FAKE_WACLI_VERSION: 'not a version' }), service: null, isGlobal: true, flags: {} });
    expect(ok).toBe(false);
    const text = t.out.join('\n');
    expect(text).toContain(`Could not read the wacli version from ${FAKE_WACLI}`);
    expect(text).toContain(`Run \`${FAKE_WACLI} version\` to check that it works.`);
    expect(text).not.toContain('older than');
  });
});

describe('runSetup service step', () => {
  it('does not offer the service for a non-global install, even when the person would say yes', async () => {
    const calls: string[] = [];
    const t = io({ answers: [true] });
    expect(await runSetup({ io: t.io, ...opts(), service: service(calls), isGlobal: false, flags: {} })).toBe(true);
    expect(calls).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.out.join('\n')).toContain('install the package globally');
  });

  it('installs the service without asking when --service is given', async () => {
    const calls: string[] = [];
    const t = io({});
    expect(await runSetup({ io: t.io, ...opts(), service: service(calls), isGlobal: true, flags: { service: true } })).toBe(true);
    expect(calls).toEqual(['install']);
    expect(t.asked).toEqual([]);
    expect(t.out.join('\n')).toContain('Installed the sync daemon service at /svc');
  });

  it('skips the service without asking when --no-service is given, even when the person would say yes', async () => {
    const calls: string[] = [];
    const t = io({ answers: [true] });
    expect(await runSetup({ io: t.io, ...opts(), service: service(calls), isGlobal: true, flags: { service: false } })).toBe(true);
    expect(calls).toEqual([]);
    expect(t.asked).toEqual([]);
    expect(t.out.join('\n')).toContain('Skipped the service');
  });

  it('reports a failed service install, still prints the rest, and returns false', async () => {
    const failing = { ...service([]), install: async (): Promise<string> => { throw new Error('launchctl bootstrap failed (5)'); } };
    const t = io({});
    const ok = await runSetup({ io: t.io, ...opts(), service: failing, isGlobal: true, flags: { service: true } });
    expect(ok).toBe(false);
    const text = t.out.join('\n');
    expect(text).toContain('Could not install the service: launchctl bootstrap failed (5)');
    expect(text).toContain('Install it later with: whatsapp-agent daemon install');
    expect(text).toContain('claude mcp add --scope user');
    expect(text).toContain(BAN_NOTICE);
    expect(text).toContain('Write tools are off');
  });

  it('says so when this platform has no service support', async () => {
    const t = io({});
    expect(await runSetup({ io: t.io, ...opts(), service: null, isGlobal: true, flags: {} })).toBe(true);
    expect(t.out.join('\n')).toContain('no service support on this platform');
  });
});

describe('realIo', () => {
  /** An output stream whose text can be read back once pending writes have flushed. */
  function sink() {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.setEncoding('utf8');
    out.on('data', (c: string) => chunks.push(c));
    return { out, text: async () => { await new Promise((r) => setImmediate(r)); return chunks.join(''); } };
  }

  /** Asks one question on a terminal-like input and feeds it `reply`. */
  async function answered(reply: string): Promise<boolean> {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const pending = realIo(input, sink().out).ask('Q');
    input.write(`${reply}\n`);
    return pending;
  }

  it('does not prompt without a terminal and says how to answer instead', async () => {
    const input = new PassThrough();
    const s = sink();
    expect(await realIo(input, s.out).ask('Install it?')).toBe(false);
    const text = await s.text();
    expect(text).toContain('Install it? [y/N]');
    expect(text).toContain('Not a terminal, so no questions are asked.');
    expect(text).toContain('--install-wacli, --service or --no-service');
    expect(input.readableFlowing).toBeNull();
  });

  it('asks on a terminal and reads the answer', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const s = sink();
    const pending = realIo(input, s.out).ask('Install it?');
    input.write('y\n');
    expect(await pending).toBe(true);
    expect(await s.text()).toContain('Install it? [y/N] ');
    expect(await answered(' YES ')).toBe(true);
    expect(await answered('')).toBe(false);
    expect(await answered('n')).toBe(false);
  });

  it('settles false when the terminal input ends before an answer', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const pending = realIo(input, sink().out).ask('Q');
    input.end();
    expect(await pending).toBe(false);
  });

  it('cancels setup on Ctrl+C at a prompt instead of answering no', async () => {
    const input = Object.assign(new PassThrough(), { isTTY: true });
    const output = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
    output.resume();
    const pending = realIo(input, output).ask('Q');
    const cancelled = expect(pending).rejects.toThrow('Setup cancelled');
    input.write('\x03');
    await cancelled;
  });

  describe('ending the line a prompt leaves open', () => {
    const terminal = () => {
      const out = Object.assign(new PassThrough(), { isTTY: true, columns: 80 });
      const chunks: string[] = [];
      out.setEncoding('utf8');
      out.on('data', (c: string) => chunks.push(c));
      return { out, text: async () => { await new Promise((r) => setImmediate(r)); return chunks.join(''); } };
    };

    it('writes a newline when the input ends at a prompt on a terminal', async () => {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      const t = terminal();
      const pending = realIo(input, t.out).ask('Q');
      input.end();
      expect(await pending).toBe(false);
      expect((await t.text()).endsWith('\n')).toBe(true);
    });

    it('writes a newline when Ctrl+C cancels at a prompt on a terminal', async () => {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      const t = terminal();
      const pending = realIo(input, t.out).ask('Q');
      const cancelled = expect(pending).rejects.toThrow('Setup cancelled');
      input.write('\x03');
      await cancelled;
      expect((await t.text()).endsWith('\n')).toBe(true);
    });

    it('writes nothing extra when the output is not a terminal', async () => {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      const s = sink();
      const pending = realIo(input, s.out).ask('Q');
      input.end();
      expect(await pending).toBe(false);
      expect(await s.text()).toBe('Q [y/N] ');
    });

    it('writes no extra blank line after an answer that was given', async () => {
      const input = Object.assign(new PassThrough(), { isTTY: true });
      const t = terminal();
      const pending = realIo(input, t.out).ask('Q');
      input.write('y\n');
      expect(await pending).toBe(true);
      expect((await t.text()).endsWith('\n\n')).toBe(false);
    });
  });

  it('prints to the injected output with a trailing newline', async () => {
    const s = sink();
    realIo(new PassThrough(), s.out).print('hello');
    expect(await s.text()).toBe('hello\n');
  });

  it('reports a command that cannot start on stderr and resolves 1', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const missing = path.join(tmp, 'no-such-binary');
      expect(await realIo().run(missing, ['auth'])).toBe(1);
      const written = stderr.mock.calls.map((c) => String(c[0])).join('');
      expect(written).toContain(`${missing}: `);
      expect(written).toContain('ENOENT');
    } finally {
      stderr.mockRestore();
    }
  });
});
