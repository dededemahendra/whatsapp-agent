import { chmod, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface Paths {
  configDir: string;
  dataDir: string;
  mediaDir: string;
  policyFile: string;
  auditFile: string;
  rateLimitFile: string;
  daemonLog: string;
}

/** An override or XDG value as an absolute path: a leading `~` or `~/` means the home directory, anything relative means the working directory. */
function absolute(value: string, home: string): string {
  const expanded = value === '~' ? home : value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  return path.resolve(expanded);
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): Paths {
  const pick = (value: string | undefined): string | undefined => (value ? absolute(value, home) : undefined);
  const configDir = pick(env.WHATSAPP_AGENT_CONFIG_DIR)
    ?? path.join(pick(env.XDG_CONFIG_HOME) ?? path.join(home, '.config'), 'whatsapp-agent');
  const dataDir = pick(env.WHATSAPP_AGENT_DATA_DIR)
    ?? path.join(pick(env.XDG_DATA_HOME) ?? path.join(home, '.local', 'share'), 'whatsapp-agent');
  return {
    configDir,
    dataDir,
    mediaDir: path.join(dataDir, 'media'),
    policyFile: path.join(configDir, 'policy.json'),
    auditFile: path.join(dataDir, 'audit.jsonl'),
    rateLimitFile: path.join(dataDir, 'rate-limit.json'),
    daemonLog: path.join(dataDir, 'daemon.log'),
  };
}

export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export async function ensureDirs(p: Paths): Promise<void> {
  for (const d of [p.configDir, p.dataDir, p.mediaDir]) await ensurePrivateDir(d);
}
