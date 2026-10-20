import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI = path.join(ROOT, 'bin', 'whatsapp-agent.mjs');

export interface RpcMessage { jsonrpc?: string; id?: number | string; method?: string; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } }

export interface RawCli {
  child: ChildProcessWithoutNullStreams;
  /** Every line the server wrote to stdout, in order, exactly as written. */
  stdoutLines: string[];
  /** Everything the server wrote to stderr. */
  stderr: () => string;
  /** Sends a request and resolves with the response that carries its id. */
  request(method: string, params?: unknown): Promise<RpcMessage>;
  notify(method: string, params?: unknown): void;
  /** Answers requests the server sends to the client (elicitation, for one). Without a handler they are left unanswered. */
  onServerRequest(handler: (message: RpcMessage) => unknown): void;
  /** Runs the 2025-era opening exchange: initialize, then the initialized notification. */
  initialize(capabilities?: Record<string, unknown>): Promise<RpcMessage>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/** Starts the built CLI's `mcp` command with this environment and speaks JSON-RPC to it over stdio by hand. The caller sets WHATSAPP_AGENT_WACLI_BIN to the fake. */
export function spawnCli(env: NodeJS.ProcessEnv): RawCli {
  const child = spawn(process.execPath, [CLI, 'mcp'], { env: env as Record<string, string>, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdoutLines: string[] = [];
  const waiting = new Map<number | string, (m: RpcMessage) => void>();
  let buffer = '';
  let errText = '';
  let serverRequest: ((message: RpcMessage) => unknown) | undefined;
  let nextId = 1;
  const send = (message: unknown): void => { child.stdin.write(`${JSON.stringify(message)}\n`); };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    for (let i = buffer.indexOf('\n'); i >= 0; i = buffer.indexOf('\n')) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (line === '') continue;
      stdoutLines.push(line);
      try {
        const m = JSON.parse(line) as RpcMessage;
        if (m.id !== undefined && waiting.has(m.id) && (m.result !== undefined || m.error !== undefined)) {
          waiting.get(m.id)!(m);
          waiting.delete(m.id);
        } else if (m.id !== undefined && m.method !== undefined && serverRequest) {
          send({ jsonrpc: '2.0', id: m.id, result: serverRequest(m) });
        }
      } catch {
        // the test that cares reads stdoutLines
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { errText += chunk; });
  child.stdin.on('error', () => undefined);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  const request = (method: string, params?: unknown): Promise<RpcMessage> => {
    const id = nextId++;
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  };
  const notify = (method: string, params?: unknown): void => send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  return {
    child, stdoutLines, stderr: () => errText, request, notify, exited,
    onServerRequest(handler) { serverRequest = handler; },
    async initialize(capabilities = {}) {
      const r = await request('initialize', { protocolVersion: '2025-06-18', capabilities, clientInfo: { name: 'raw-test', version: '0.0.0' } });
      notify('notifications/initialized');
      return r;
    },
  };
}
