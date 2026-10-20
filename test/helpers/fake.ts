import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FAKE_WACLI = fileURLToPath(new URL('../fixtures/fake-wacli.mjs', import.meta.url));
export const FIXTURES = fileURLToPath(new URL('../fixtures/responses', import.meta.url));

export interface ArgvRecord { argv: string[]; key: string; env: Record<string, string | undefined> }

export async function makeTmp(prefix = 'wa-test-'): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTmp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Environment for spawning the fake. Strips inherited wacli variables the runner must set itself; values passed in `extra` are kept. */
export function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WACLI_READONLY;
  delete env.WACLI_MEDIA_ROOTS;
  delete env.NO_COLOR;
  return { ...env, FAKE_WACLI_FIXTURES: FIXTURES, ...extra };
}

export async function readArgvLog(file: string): Promise<ArgvRecord[]> {
  try {
    const text = await readFile(file, 'utf8');
    return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as ArgvRecord);
  } catch {
    return [];
  }
}
