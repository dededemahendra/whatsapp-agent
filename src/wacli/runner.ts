import { execFile as execFileCb, type ExecFileException } from 'node:child_process';
import { AgentError } from '../errors.js';
import { debug } from '../log.js';
import { parseVersion } from '../version.js';

export const READ_TIMEOUT_MS = 30_000;
export const WRITE_TIMEOUT_MS = 90_000;
export const MEDIA_TIMEOUT_MS = 120_000;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const SEND_UNCERTAIN = 'The outcome is uncertain: read the chat before retrying, because the message may have gone through.';

export interface RunOptions {
  timeoutMs?: number;
  env?: Record<string, string>;
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

export function classifyMessage(message: string, stderr = ''): AgentError {
  const m = message.toLowerCase();
  if (m.includes('not authenticated')) {
    return new AgentError('not_authenticated', 'WhatsApp is not paired on this machine. Run `whatsapp-agent setup` and scan the QR code.');
  }
  if (m.includes('session was revoked') || m.includes('logged out') || m.includes('logged_out')) {
    return new AgentError('session_logged_out', 'WhatsApp revoked the linked session. Run `whatsapp-agent setup` to pair again.');
  }
  if (m.includes('store is locked') || m.includes('waiting for store lock')) {
    return new AgentError('store_locked', 'The wacli store is locked by another process. Check `whatsapp-agent daemon status`.');
  }
  if (m.includes('deadline exceeded') || m.includes('timed out') || m.includes('timeout')) {
    return new AgentError('timeout', `wacli reported a timeout: ${message}. If this was a send, read the chat before retrying: the message may have gone through.`);
  }
  if (m.includes('not found') || m.includes('no such') || m.includes('unknown chat')) {
    return new AgentError('not_found', message);
  }
  return new AgentError('wacli_error', message, stderr ? { stderr_tail: tail(stderr) } : {});
}

export function parseEnvelope<T>(stdout: string, stderr: string): T {
  let env: Envelope;
  try {
    env = JSON.parse(stdout.trim()) as Envelope;
  } catch {
    try {
      env = JSON.parse(lastNonEmptyLine(stdout)) as Envelope;
    } catch {
      throw new AgentError('wacli_error', 'wacli returned output that is not JSON', { stderr_tail: tail(stderr) });
    }
  }
  if (!env.success) throw classifyMessage(env.error ?? 'wacli reported failure', stderr);
  return env.data as T;
}

export function classifyFailure(code: number, stdout: string, stderr: string): AgentError {
  const line = lastNonEmptyLine(stderr) || lastNonEmptyLine(stdout);
  try {
    const env = JSON.parse(line) as Partial<Envelope>;
    if (env && env.success === false && typeof env.error === 'string') return classifyMessage(env.error, stderr);
  } catch {
    // not JSON; fall through
  }
  return classifyMessage(line || `wacli exited with code ${code}`, stderr);
}

function markUncertain(err: AgentError): AgentError {
  if (err.code !== 'wacli_error' && err.code !== 'timeout') return err;
  const message = err.message.includes('may have gone through') ? err.message : `${err.message} ${SEND_UNCERTAIN}`;
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
    const env: NodeJS.ProcessEnv = { ...baseEnv, NO_COLOR: '1', ...opts.env };
    if (mode === 'read') env.WACLI_READONLY = '1';
    else delete env.WACLI_READONLY;
    debug('wacli', { mode, command: args.slice(0, 2).join(' ') });
    let r: SpawnResult;
    try {
      r = await spawn(cfg.bin, full, env, timeoutMs);
    } catch (e) {
      throw mode === 'write' && e instanceof AgentError ? markUncertain(e) : e;
    }
    if (r.code !== 0) {
      const err = classifyFailure(r.code, r.stdout, r.stderr);
      throw mode === 'write' ? markUncertain(err) : err;
    }
    return parseEnvelope<T>(r.stdout, r.stderr);
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
