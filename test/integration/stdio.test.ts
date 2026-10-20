import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE_WACLI, fakeEnv, makeTmp, removeTmp } from '../helpers/fake.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let tmp: string;

beforeAll(async () => {
  tmp = await makeTmp();
  await promisify(execFile)('pnpm', ['build'], { cwd: ROOT });
}, 120_000);
afterAll(async () => { await removeTmp(tmp); });

describe('whatsapp-agent mcp over stdio', () => {
  it('serves tools to a stdio client using the fake wacli', async () => {
    const env = Object.fromEntries(Object.entries(fakeEnv({
      WHATSAPP_AGENT_WACLI_BIN: FAKE_WACLI,
      WHATSAPP_AGENT_CONFIG_DIR: path.join(tmp, 'config'),
      WHATSAPP_AGENT_DATA_DIR: path.join(tmp, 'data'),
    })).filter((e): e is [string, string] => typeof e[1] === 'string'));
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', 'whatsapp-agent.mjs'), 'mcp'], env }));
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
});
