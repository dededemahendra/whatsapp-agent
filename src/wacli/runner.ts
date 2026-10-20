import { execFile as execFileCb, type ExecFileException } from 'node:child_process';
import { AgentError } from '../errors.js';
import { debug } from '../log.js';
import { MIN_WACLI_VERSION, parseVersion } from '../version.js';

export const READ_TIMEOUT_MS = 30_000;
export const WRITE_TIMEOUT_MS = 90_000;
export const MEDIA_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MATCH_CAP = 4096;
const UNREADABLE = 'wacli returned an unreadable response';
const REPEATED_SEND = /repeated send/i;
export const SEND_UNCERTAIN = 'The outcome is uncertain: read the chat before retrying, because the message may have gone through.';

export interface RunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
  /** The write can be repeated without harm, so a failure is not reported as an uncertain outcome. */
  idempotent?: boolean;
}

export interface SpawnResult { stdout: string; stderr: string; code: number }
export type SpawnFn = (bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<SpawnResult>;

export interface RunnerConfig {
  bin: string;
  account?: string | null;
  baseEnv?: NodeJS.ProcessEnv;
  spawn?: SpawnFn;
}

export interface Runner {
  readonly bin: string;
  read<T>(args: string[], opts?: RunOptions): Promise<T>;
  write<T>(args: string[], opts?: RunOptions): Promise<T>;
  version(): Promise<string | null>;
}

interface Envelope { success: boolean; data: unknown; error: string | null }
type Found = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'envelope'; env: Record<string, unknown> };

export const defaultSpawn: SpawnFn = (bin, args, env, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFileCb(
      bin,
      args,
      { env, timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, code: 0 });
          return;
        }
        const e = err as ExecFileException & { stdout?: string; stderr?: string };
        if (e.code === 'ENOENT') {
          reject(new AgentError('wacli_not_installed',
            `wacli was not found at "${bin}". Install it with: brew install openclaw/tap/wacli, then run: whatsapp-agent setup`));
          return;
        }
        if (e.killed && e.signal === 'SIGKILL') {
          reject(new AgentError('timeout',
            `wacli did not finish within ${Math.round(timeoutMs / 1000)} seconds. If this was a send, read the chat before retrying: the message may have gone through.`));
          return;
        }
        if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new AgentError('wacli_error', 'wacli output exceeded 16 MiB. Narrow the query or lower the limit.'));
          return;
        }
        resolve({
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          code: typeof e.code === 'number' ? e.code : 1,
        });
      },
    );
  });

export function tail(s: string, n = 2048): string {
  return s.length <= n ? s : s.slice(-n);
}

function lastNonEmptyLine(s: string): string {
  const lines = s.trim().split('\n');
  return (lines[lines.length - 1] ?? '').trim();
}

function tooOld(stderr: string): AgentError {
  return new AgentError('wacli_too_old', `wacli is older than the minimum ${MIN_WACLI_VERSION}. Upgrade with: brew upgrade wacli`, stderr ? { stderr_tail: tail(stderr) } : {});
}

function unreadable(stderr: string): AgentError {
  return new AgentError('wacli_error', UNREADABLE, stderr ? { stderr_tail: tail(stderr) } : {});
}

/** Lower-cased text to match keywords against, capped, without quoted spans or path-like tokens: those can carry user input such as a file or recipient name. */
function forMatching(text: string): string {
  return text.slice(0, MATCH_CAP).toLowerCase()
    .replace(/"[^"\n]*"/g, ' ')
    .replace(/(?<!\w)'[^'\n]*'(?!\w)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\/\S+/g, ' ');
}

/** Maps wacli's wording to an error code. `text` is what the keywords are matched against; `message` is what the agent reads when nothing matches. */
function classify(message: string, text: string, stderr: string): AgentError {
  const m = forMatching(text);
  if (m.includes('unknown flag: --read-only') || m.includes('unknown flag: --account') || m.includes('unknown flag: --timeout')) {
    return tooOld(stderr);
  }
  if (m.includes('not authenticated')) {
    return new AgentError('not_authenticated', 'WhatsApp is not paired on this machine. Run `whatsapp-agent setup` and scan the QR code.');
  }
  if (m.includes('session was revoked') || m.includes('logged out') || m.includes('logged_out')) {
    return new AgentError('session_logged_out', 'WhatsApp revoked the linked session. Run `whatsapp-agent setup` to pair again.');
  }
  if (m.includes('store is locked') || m.includes('waiting for store lock')) {
    return new AgentError('store_locked', 'The wacli store is locked by another process. Check `whatsapp-agent daemon status`.');
  }
  if (m.includes('not found') || m.includes('no such') || m.includes('unknown chat')) {
    return new AgentError('not_found', message);
  }
  if (m.includes('deadline exceeded') || m.includes('timed out') || m.includes('timeout')) {
    return new AgentError('timeout', `wacli reported a timeout: ${message}. If this was a send, read the chat before retrying: the message may have gone through.`);
  }
  return new AgentError('wacli_error', message, stderr ? { stderr_tail: tail(stderr) } : {});
}

export function classifyMessage(message: string, stderr = ''): AgentError {
  return classify(message, message, stderr);
}

/** Finds the envelope in a stream: the whole text as JSON first, then each non-empty line from the last backwards. */
function findEnvelope(text: string): Found {
  const t = text.trim();
  if (t === '') return { kind: 'none' };
  const lines = t.split('\n').map((l) => l.trim()).filter((l) => l !== '').reverse();
  for (const [i, attempt] of [t, ...lines].entries()) {
    let v: unknown;
    try {
      v = JSON.parse(attempt);
    } catch {
      continue;
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) return { kind: 'envelope', env: v as Record<string, unknown> };
    if (i === 0) return { kind: 'unreadable' };
  }
  return { kind: 'none' };
}

/** The error a failure envelope reports: classified when it is a string, unreadable when it is anything else, null when absent. */
function failureOf(env: Record<string, unknown>, stderr: string): AgentError | null {
  if (typeof env.error === 'string') return classifyMessage(env.error, stderr);
  return env.error === undefined || env.error === null ? null : unreadable(stderr);
}

export function parseEnvelope<T>(stdout: string, stderr: string): T {
  const found = findEnvelope(stdout);
  if (found.kind === 'none') throw new AgentError('wacli_error', 'wacli returned output that is not JSON', { stderr_tail: tail(stderr) });
  if (found.kind === 'unreadable') throw unreadable(stderr);
  if (found.env.success) return found.env.data as T;
  throw failureOf(found.env, stderr) ?? classifyMessage('wacli reported failure', stderr);
}

/** A failed run: wacli's JSON error envelope on stderr (or stdout when stderr is empty) when there is one, else the keywords in the whole text. */
export function classifyFailure(code: number, stdout: string, stderr: string): AgentError {
  const text = stderr.trim() !== '' ? stderr : stdout;
  const found = findEnvelope(text);
  if (found.kind === 'unreadable') return unreadable(stderr);
  if (found.kind === 'envelope' && found.env.success === false) {
    const err = failureOf(found.env, stderr);
    if (err) return err;
  }
  return classify(lastNonEmptyLine(text) || `wacli exited with code ${code}`, text, stderr);
}

function markUncertain(err: AgentError): AgentError {
  if (err.code !== 'wacli_error' && err.code !== 'timeout') return err;
  const base = err.message.replace(/[\s.]+$/, '');
  const message = err.message.includes('may have gone through') ? err.message : `${base}. ${SEND_UNCERTAIN}`;
  return new AgentError(err.code, message, { ...err.details, outcome_uncertain: true });
}

export function createRunner(cfg: RunnerConfig): Runner {
  const spawn = cfg.spawn ?? defaultSpawn;
  const prefix = cfg.account ? ['--account', cfg.account] : [];
  const baseEnv = cfg.baseEnv ?? process.env;

  async function run<T>(mode: 'read' | 'write', args: string[], opts: RunOptions): Promise<T> {
    const timeoutMs = opts.timeoutMs ?? (mode === 'read' ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS);
    const wacliTimeout = `${Math.max(1, Math.floor(timeoutMs / 1000) - 5)}s`;
    const full = [...prefix, '--json', '--timeout', wacliTimeout, ...(mode === 'read' ? ['--read-only'] : []), ...args];
    if (full.some((a) => a.includes('\0'))) throw new AgentError('invalid_input', 'Input must not contain NUL characters.');
    // A failed write may or may not have gone through, unless repeating it is harmless.
    const mark = mode === 'write' && !opts.idempotent ? markUncertain : (e: AgentError): AgentError => e;
    const env: NodeJS.ProcessEnv = { ...baseEnv, NO_COLOR: '1', ...opts.env };
    if (mode === 'read') env.WACLI_READONLY = '1';
    else delete env.WACLI_READONLY;
    debug('wacli', { mode, command: args.slice(0, 2).join(' ') });
    let r: SpawnResult;
    try {
      r = await spawn(cfg.bin, full, env, timeoutMs);
    } catch (e) {
      throw e instanceof AgentError ? mark(e) : e;
    }
    if (r.code !== 0) throw mark(classifyFailure(r.code, r.stdout, r.stderr));
    let data: T;
    try {
      data = parseEnvelope<T>(r.stdout, r.stderr);
    } catch (e) {
      throw e instanceof AgentError ? mark(e) : e;
    }
    if (mode === 'write' && REPEATED_SEND.test(r.stderr)) debug('wacli warning', { kind: 'repeated_send' });
    return data;
  }

  return {
    bin: cfg.bin,
    read: (args, opts = {}) => run('read', args, opts),
    write: (args, opts = {}) => run('write', args, opts),
    async version() {
      const r = await spawn(cfg.bin, ['version'], { ...baseEnv, NO_COLOR: '1' }, 10_000);
      return r.code === 0 ? parseVersion(r.stdout) : null;
    },
  };
}
