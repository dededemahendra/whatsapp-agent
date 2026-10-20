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

    /** A policy that lets send_text through without a prompt, so the test can drive a write with no elicitation. */
    async function writableEnv(dir: string, sleepMs: number): Promise<{ env: Record<string, string>; log: string }> {
      const log = path.join(dir, 'argv.log');
      const policy = { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true, confirm: 'never' as const, rateLimit: { perHour: 20, minGapSeconds: 0 } } };
      await savePolicy(path.join(dir, 'config', 'policy.json'), policy);
      return { env: cliEnv(dir, { FAKE_WACLI_LOG: log, FAKE_WACLI_SLEEP_MS: String(sleepMs) }), log };
    }
    const sendStarted = (log: string) => async (): Promise<boolean> => (await readArgvLog(log)).some((r) => r.key === 'send text');

    it('lets a write that is already running finish and be recorded, then exits 0', async () => {
      const dir = await makeTmp('wa-stop-');
      try {
        const { env, log } = await writableEnv(dir, 500);
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
        const { env, log } = await writableEnv(dir, 2500);
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
});
