import path from 'node:path';
import { Client, StreamableHTTPClientTransport, type ClientCapabilities, type ElicitResult } from '@modelcontextprotocol/client';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { ServerDeps } from '../../src/mcp/deps.js';
import { createServer } from '../../src/mcp/server.js';
import { resolvePaths } from '../../src/paths.js';
import { appendAudit, type AuditRecord } from '../../src/policy/audit.js';
import { createRateLimiter } from '../../src/policy/ratelimit.js';
import { DEFAULT_POLICY, type Policy } from '../../src/policy/schema.js';
import { createResolver } from '../../src/wacli/resolve.js';
import { createRunner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, makeTmp, readArgvLog, removeTmp, type ArgvRecord } from './fake.js';

export interface ToolResult {
  isError?: boolean;
  structuredContent?: unknown;
  content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
}

export interface HarnessOptions {
  policy?: (p: Policy) => Policy;
  env?: Record<string, string>;
  elicitation?: 'form' | 'none' | 'url-only';
  elicit?: (message: string) => { action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> };
  now?: Date;
}

export interface Harness {
  client: Client;
  deps: ServerDeps;
  tmp: string;
  audits: AuditRecord[];
  elicitations: string[];
  argv(): Promise<ArgvRecord[]>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolResult>;
  close(): Promise<void>;
}

export function errorOf(r: ToolResult): { error: string; message: string } & Record<string, unknown> {
  return JSON.parse(r.content[0]?.text ?? '{}');
}

export async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const tmp = await makeTmp('wa-harness-');
  const log = path.join(tmp, 'argv.log');
  const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'config'), WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'data') }, tmp);
  const runner = createRunner({
    bin: FAKE_WACLI,
    baseEnv: fakeEnv({ FAKE_WACLI_LOG: log, FAKE_WACLI_STORE_DIR: path.join(tmp, 'store'), ...opts.env }),
  });
  const policy = (opts.policy ?? ((p) => p))(structuredClone(DEFAULT_POLICY));
  const audits: AuditRecord[] = [];
  const deps: ServerDeps = {
    runner,
    resolver: createResolver(runner),
    loadPolicy: async () => policy,
    startupPolicy: policy,
    paths,
    rateLimiter: createRateLimiter(paths.rateLimitFile),
    audit: async (rec) => { audits.push(rec); await appendAudit(paths.auditFile, rec); },
    now: () => opts.now ?? new Date(),
  };

  const handler = createMcpHandler(() => createServer(deps));
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url as string, init)),
  });
  const mode = opts.elicitation ?? 'form';
  const capabilities: ClientCapabilities = mode === 'form' ? { elicitation: { form: {} } } : mode === 'url-only' ? { elicitation: { url: {} } } : {};
  const client = new Client({ name: 'harness', version: '0.0.0' }, { capabilities, versionNegotiation: { mode: 'auto' } });
  const elicitations: string[] = [];
  if (mode !== 'none') {
    client.setRequestHandler('elicitation/create', async (request) => {
      const message = String((request.params as { message?: string }).message ?? '');
      elicitations.push(message);
      const answer = opts.elicit ? opts.elicit(message) : { action: 'accept' as const, content: { confirm: true } };
      return answer.action === 'accept' ? { action: 'accept', content: (answer.content ?? { confirm: true }) as NonNullable<ElicitResult['content']> } : { action: answer.action };
    });
  }
  await client.connect(transport);

  return {
    client,
    deps,
    tmp,
    audits,
    elicitations,
    argv: () => readArgvLog(log),
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as ToolResult,
    close: async () => {
      await client.close();
      await handler.close();
      await removeTmp(tmp);
    },
  };
}
