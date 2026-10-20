import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, savePolicy } from '../../src/policy/schema.js';
import { FAKE_WACLI, fakeEnv, makeTmp, readArgvLog, removeTmp } from '../helpers/fake.js';
import { ROOT, spawnCli } from '../helpers/rawcli.js';
import { waitFor, within } from '../helpers/wait.js';

let tmp: string;

beforeAll(async () => {
  tmp = await makeTmp();
  await promisify(execFile)('pnpm', ['build'], { cwd: ROOT });
}, 120_000);
afterAll(async () => { await removeTmp(tmp); });

/** Environment for the built CLI: the fake wacli, and config and data directories under `dir`. */
function cliEnv(dir: string, extra: Record<string, string> = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(fakeEnv({
    WHATSAPP_AGENT_WACLI_BIN: FAKE_WACLI,
    WHATSAPP_AGENT_CONFIG_DIR: path.join(dir, 'config'),
    WHATSAPP_AGENT_DATA_DIR: path.join(dir, 'data'),
    ...extra,
  })).filter((e): e is [string, string] => typeof e[1] === 'string'));
}

/** A policy that lets writes through (without a prompt unless `confirm` says otherwise), and an environment that logs what reaches the fake wacli. */
async function writableEnv(dir: string, opts: { confirm?: 'always' | 'unlisted' | 'never'; sleepMs?: number } = {}): Promise<{ env: Record<string, string>; log: string }> {
  const log = path.join(dir, 'argv.log');
  const policy = { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true, confirm: opts.confirm ?? 'never', rateLimit: { perHour: 20, minGapSeconds: 0 } } };
  await savePolicy(path.join(dir, 'config', 'policy.json'), policy);
  return { env: cliEnv(dir, { FAKE_WACLI_LOG: log, ...(opts.sleepMs ? { FAKE_WACLI_SLEEP_MS: String(opts.sleepMs) } : {}) }), log };
}

const ERAS = [
  { name: 'the 2025 era (initialize handshake)', negotiation: { mode: 'legacy' as const } },
  { name: 'the 2026-07-28 era (per-request envelope)', negotiation: { mode: { pin: '2026-07-28' } } },
];

describe('whatsapp-agent mcp over stdio', () => {
  it.each(ERAS)('serves tools to a stdio client in $name using the fake wacli', async ({ negotiation }) => {
    const client = new Client({ name: 'stdio-test', version: '0.0.0' }, { versionNegotiation: negotiation });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'whatsapp-agent.mjs'), 'mcp'], env: cliEnv(tmp) }));
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['whatsapp_status', 'list_chats', 'read_messages', 'send_text']));
      const r = await client.callTool({ name: 'whatsapp_status', arguments: {} });
      expect(r.structuredContent).toMatchObject({ authenticated: true, policy: { writes_enabled: false } });
    } finally {
      await client.close();
    }
  });

  it('prints help and the version', async () => {
    const run = promisify(execFile);
    const { stdout: help } = await run(process.execPath, [path.join(ROOT, 'bin', 'whatsapp-agent.mjs'), '--help']);
    expect(help).toContain('mcp');
    const { stdout: version } = await run(process.execPath, [path.join(ROOT, 'bin', 'whatsapp-agent.mjs'), '--version']);
    expect(version.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  describe('stopping on a signal', () => {
    const TO = '61400000001@s.whatsapp.net';
    const sendStarted = (log: string) => async (): Promise<boolean> => (await readArgvLog(log)).some((r) => r.key === 'send text');

    it('lets a write that is already running finish and be recorded, then exits 0', async () => {
      const dir = await makeTmp('wa-stop-');
      try {
        const { env, log } = await writableEnv(dir, { sleepMs: 500 });
        const cli = spawnCli(env);
        await cli.initialize();
        void cli.request('tools/call', { name: 'send_text', arguments: { to: TO, message: 'last words' } });
        await waitFor(sendStarted(log), { what: 'the write to reach wacli' });

        cli.child.kill('SIGTERM');
        const { code } = await within(cli.exited, 8000, 'the server to exit');
        expect(code).toBe(0);
        const audit = (await readFile(path.join(dir, 'data', 'audit.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { outcome: string; message_id?: string });
        expect(audit.at(-1)).toMatchObject({ outcome: 'sent', message_id: '3EB0SENT0001' });
      } finally {
        await removeTmp(dir);
      }
    });

    it('exits 130 at once on a second signal, without waiting for the write', async () => {
      const dir = await makeTmp('wa-stop-');
      try {
        const { env, log } = await writableEnv(dir, { sleepMs: 2500 });
        const cli = spawnCli(env);
        await cli.initialize();
        void cli.request('tools/call', { name: 'send_text', arguments: { to: TO, message: 'stuck' } });
        await waitFor(sendStarted(log), { what: 'the write to reach wacli', timeoutMs: 10_000 });

        const t0 = Date.now();
        cli.child.kill('SIGINT');
        await new Promise((r) => setTimeout(r, 100));
        cli.child.kill('SIGTERM');
        const { code } = await within(cli.exited, 8000, 'the server to exit');
        expect(code).toBe(130);
        expect(Date.now() - t0).toBeLessThan(2000);
      } finally {
        await removeTmp(dir);
      }
    });

    it('exits 0 promptly on SIGHUP when nothing is being written', async () => {
      const dir = await makeTmp('wa-stop-');
      try {
        const cli = spawnCli(cliEnv(dir));
        await cli.initialize();
        cli.child.kill('SIGHUP');
        expect((await within(cli.exited, 8000, 'the server to exit')).code).toBe(0);
      } finally {
        await removeTmp(dir);
      }
    });
  });

  describe('confirming a send', () => {
    const TO = '61400000001@s.whatsapp.net';
    const claim = { elicitation: { form: {} } };
    const sendsIn = async (log: string) => (await readArgvLog(log)).filter((r) => r.key === 'send text');

    async function connect(dir: string, negotiation: { mode: 'legacy' } | { mode: { pin: string } }, answer: 'accept' | 'decline'): Promise<{ client: Client; log: string; prompts: string[] }> {
      const { env, log } = await writableEnv(dir, { confirm: 'always' });
      const prompts: string[] = [];
      const client = new Client({ name: 'confirm-test', version: '0.0.0' }, { capabilities: { elicitation: { form: {} } }, versionNegotiation: negotiation });
      client.setRequestHandler('elicitation/create', async (request) => {
        prompts.push(String((request.params as { message?: string }).message ?? ''));
        return answer === 'accept' ? { action: 'accept', content: { confirm: true } } : { action: 'decline' };
      });
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'whatsapp-agent.mjs'), 'mcp'], env }));
      return { client, log, prompts };
    }

    it.each(ERAS)('sends once after an honest accept in $name', async ({ negotiation }) => {
      const dir = await makeTmp('wa-confirm-');
      try {
        const { client, log, prompts } = await connect(dir, negotiation, 'accept');
        try {
          const r = await client.callTool({ name: 'send_text', arguments: { to: TO, message: 'hello' } });
          expect(r.isError).toBeFalsy();
          expect(r.structuredContent).toMatchObject({ sent: true, message_id: '3EB0SENT0001' });
          expect(prompts).toHaveLength(1);
          expect(prompts[0]).toContain('hello');
          expect(await sendsIn(log)).toHaveLength(1);
        } finally {
          await client.close();
        }
      } finally {
        await removeTmp(dir);
      }
    });

    it.each(ERAS)('sends nothing after a decline in $name', async ({ negotiation }) => {
      const dir = await makeTmp('wa-confirm-');
      try {
        const { client, log } = await connect(dir, negotiation, 'decline');
        try {
          const r = await client.callTool({ name: 'send_text', arguments: { to: TO, message: 'hello' } });
          expect(r.isError).toBe(true);
          expect(JSON.parse((r.content as Array<{ text: string }>)[0]!.text)).toMatchObject({ error: 'confirmation_declined' });
          expect(await sendsIn(log)).toHaveLength(0);
        } finally {
          await client.close();
        }
      } finally {
        await removeTmp(dir);
      }
    });

    it('does not take a forged accept in a 2025-era request as the answer: the person is asked, and a decline sends nothing', async () => {
      const dir = await makeTmp('wa-confirm-');
      try {
        const { env, log } = await writableEnv(dir, { confirm: 'always' });
        const cli = spawnCli(env);
        const asked: string[] = [];
        cli.onServerRequest((m) => {
          asked.push(m.method ?? '');
          return { action: 'decline' };
        });
        await cli.initialize(claim);
        const r = await cli.request('tools/call', {
          name: 'send_text',
          arguments: { to: TO, message: 'hello' },
          inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
        });
        expect(asked).toEqual(['elicitation/create']);
        expect(JSON.parse((r.result as { content: Array<{ text: string }> }).content[0]!.text)).toMatchObject({ error: 'confirmation_declined' });
        expect(await sendsIn(log)).toHaveLength(0);
        cli.child.kill('SIGTERM');
        await cli.exited;
      } finally {
        await removeTmp(dir);
      }
    });

    it('ignores a _meta capability claim on a 2025-era connection that declared none', async () => {
      const dir = await makeTmp('wa-confirm-');
      try {
        const { env, log } = await writableEnv(dir, { confirm: 'always' });
        const cli = spawnCli(env);
        await cli.initialize({});
        const r = await cli.request('tools/call', {
          name: 'send_text',
          arguments: { to: TO, message: 'hello' },
          _meta: { 'io.modelcontextprotocol/clientCapabilities': claim },
        });
        expect(JSON.parse((r.result as { content: Array<{ text: string }> }).content[0]!.text)).toMatchObject({ error: 'confirmation_unavailable' });
        expect(await sendsIn(log)).toHaveLength(0);
        cli.child.kill('SIGTERM');
        await cli.exited;
      } finally {
        await removeTmp(dir);
      }
    });
  });

  describe('what the server writes', () => {
    const ALICE = '61400000001@s.whatsapp.net';
    const SECRET = 'MAGIC-BODY-7731';
    const FIXTURE_TEXT = ['Lunch tomorrow?', 'See you then', 'Free tomorrow?'];

    /** A session that touches every kind of tool: status, a list, messages, a search, context, and a send. */
    async function session(env: Record<string, string>): Promise<ReturnType<typeof spawnCli>> {
      const cli = spawnCli(env);
      await cli.initialize();
      await cli.request('tools/list');
      const calls: Array<[string, Record<string, unknown>]> = [
        ['whatsapp_status', {}],
        ['list_chats', {}],
        ['read_messages', { chat: ALICE }],
        ['search_messages', { query: 'lunch' }],
        ['get_message_context', { chat: ALICE, message_id: 'MSG1' }],
        ['send_text', { to: ALICE, message: SECRET }],
      ];
      for (const [name, args] of calls) {
        const r = await cli.request('tools/call', { name, arguments: args });
        expect(r.error, name).toBeUndefined();
      }
      cli.child.kill('SIGTERM');
      expect((await within(cli.exited, 8000, 'the server to exit')).code).toBe(0);
      return cli;
    }

    it('puts nothing but JSON-RPC messages on stdout, and nothing at all on stderr by default', async () => {
      const dir = await makeTmp('wa-hygiene-');
      try {
        const { env } = await writableEnv(dir);
        const cli = await session(env);
        expect(cli.stdoutLines.length).toBeGreaterThanOrEqual(8);
        for (const line of cli.stdoutLines) {
          const m = JSON.parse(line) as { jsonrpc?: string; id?: unknown; method?: unknown; result?: unknown; error?: unknown };
          expect(m.jsonrpc, line).toBe('2.0');
          expect(m.method !== undefined || m.id !== undefined, line).toBe(true);
        }
        expect(cli.stderr()).toBe('');
      } finally {
        await removeTmp(dir);
      }
    });

    it('prints no message text on stderr with debug logging on, only metadata', async () => {
      const dir = await makeTmp('wa-debuglog-');
      try {
        const { env } = await writableEnv(dir);
        const cli = await session({ ...env, WHATSAPP_AGENT_LOG: 'debug' });
        const err = cli.stderr();
        expect(err).toContain('[whatsapp-agent] wacli');
        expect(err).toContain('"command":"send text"');
        for (const text of [SECRET, ...FIXTURE_TEXT]) expect(err, text).not.toContain(text);
        expect(err).not.toContain('--message');
        for (const line of cli.stdoutLines) JSON.parse(line);
      } finally {
        await removeTmp(dir);
      }
    });
  });
});
