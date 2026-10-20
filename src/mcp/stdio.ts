import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { debug } from '../log.js';
import { ensureDirs, resolvePaths, type Paths } from '../paths.js';
import { appendAudit } from '../policy/audit.js';
import { createRateLimiter } from '../policy/ratelimit.js';
import { loadPolicy, type Policy } from '../policy/schema.js';
import { createResolver } from '../wacli/resolve.js';
import { createRunner } from '../wacli/runner.js';
import type { ServerDeps } from './deps.js';
import { createServer } from './server.js';
import { drainInFlight } from './tools/send.js';

export async function buildDeps(env: NodeJS.ProcessEnv = process.env): Promise<{ deps: ServerDeps; paths: Paths; policy: Policy }> {
  const paths = resolvePaths(env);
  await ensureDirs(paths);
  const policy = await loadPolicy(paths.policyFile);
  const runner = createRunner({ bin: env.WHATSAPP_AGENT_WACLI_BIN || 'wacli', account: policy.account, baseEnv: env });
  const deps: ServerDeps = {
    runner,
    resolver: createResolver(runner),
    loadPolicy: () => loadPolicy(paths.policyFile),
    startupPolicy: policy,
    paths,
    rateLimiter: createRateLimiter(paths.rateLimitFile),
    audit: (rec) => appendAudit(paths.auditFile, rec),
    now: () => new Date(),
  };
  return { deps, paths, policy };
}

/** Reports a transport error without its message, which could quote a chat. */
export function logStdioError(e: Error): void {
  debug('stdio', { error: e.name });
}

export interface StopHooks {
  /** Registers a signal listener. Defaults to `process.on`. */
  on?: (signal: NodeJS.Signals, listener: () => void) => void;
  /** Ends the process. Defaults to `process.exit`. */
  exit?: (code: number) => void;
  /** Waits for writes in flight, for at most the given milliseconds. Defaults to `drainInFlight`. */
  drain?: (timeoutMs: number) => Promise<void>;
  /** How long a stop waits for writes in flight. Defaults to 10 seconds. */
  drainMs?: number;
}

/**
 * On SIGINT, SIGTERM or SIGHUP: stop accepting requests by closing the transport, give writes already in flight up to ten seconds to be
 * recorded, then exit 0. A second signal exits 130 at once, so a stuck stop can always be forced.
 */
export function installGracefulStop(handle: { close(): Promise<void> }, hooks: StopHooks = {}): void {
  const on = hooks.on ?? ((signal, listener) => { process.on(signal, listener); });
  const exit = hooks.exit ?? ((code) => process.exit(code));
  const drain = hooks.drain ?? drainInFlight;
  let stopping = false;
  let exited = false;
  const finish = (code: number): void => {
    if (exited) return;
    exited = true;
    exit(code);
  };
  const stop = (): void => {
    if (stopping) {
      finish(130);
      return;
    }
    stopping = true;
    void (async () => {
      try {
        await handle.close();
      } catch (e) {
        debug('stdio close failed', { error: e instanceof Error ? e.name : 'unknown' });
      }
      await drain(hooks.drainMs ?? 10_000).catch(() => undefined);
      finish(0);
    })();
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) on(signal, stop);
}

export async function runMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { deps } = await buildDeps(env);
  // One factory serves both protocol eras: the connection's opening exchange picks the era.
  const handle = serveStdio(() => createServer(deps), { legacy: 'serve', onerror: logStdioError });
  installGracefulStop(handle);
}
