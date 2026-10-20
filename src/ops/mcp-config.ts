import os from 'node:os';
import path from 'node:path';
import { resolvePaths, type Paths } from '../paths.js';

/** The directory overrides a host must pass so the server reads the same policy and data as this command line: only those that differ from the defaults. */
function hostEnv(paths: Paths | undefined, home: string): Record<string, string> {
  if (!paths) return {};
  const defaults = resolvePaths({}, home);
  const env: Record<string, string> = {};
  if (path.resolve(paths.configDir) !== defaults.configDir) env.WHATSAPP_AGENT_CONFIG_DIR = paths.configDir;
  if (path.resolve(paths.dataDir) !== defaults.dataDir) env.WHATSAPP_AGENT_DATA_DIR = paths.dataDir;
  return env;
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function claudeMcpAddCommand(paths?: Paths, home: string = os.homedir()): string {
  const env = Object.entries(hostEnv(paths, home)).map(([k, v]) => `--env ${k}=${shellQuote(v)}`);
  return ['claude mcp add --scope user', ...env, 'whatsapp -- npx -y whatsapp-agent mcp'].join(' ');
}

export function mcpConfigJson(paths?: Paths, home: string = os.homedir()): string {
  const env = hostEnv(paths, home);
  const server: { command: string; args: string[]; env?: Record<string, string> } = { command: 'npx', args: ['-y', 'whatsapp-agent', 'mcp'] };
  if (Object.keys(env).length > 0) server.env = env;
  return JSON.stringify({ mcpServers: { whatsapp: server } }, null, 2);
}

export function mcpConfigHelp(paths?: Paths, home: string = os.homedir()): string {
  return [
    'Connect an agent host:',
    `  Claude Code:                 ${claudeMcpAddCommand(paths, home)}`,
    '  Claude Desktop or Cursor:    add this to the host\'s MCP settings file:',
    ...mcpConfigJson(paths, home).split('\n').map((l) => `    ${l}`),
    '  A global install (npm i -g whatsapp-agent) avoids npx start-up delay and is required for daemon install.',
  ].join('\n');
}
