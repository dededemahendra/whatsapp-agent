import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/** Copies the stock fixtures into a new temp directory and overwrites the named files, for tests that need another canned response. The caller removes the directory. */
export async function fixturesWith(overrides: Record<string, string>): Promise<string> {
  const dir = await makeTmp('wa-fixtures-');
  await cp(FIXTURES, dir, { recursive: true });
  for (const [name, body] of Object.entries(overrides)) await writeFile(path.join(dir, name), body);
  return dir;
}

/** Environment for spawning the fake. Strips inherited wacli variables the runner must set itself, and the whatsapp-agent overrides (binary, config and data directories, log level) so a developer's own setup cannot leak into a test; values passed in `extra` are kept. */
export function fakeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.WACLI_READONLY;
  delete env.WACLI_MEDIA_ROOTS;
  delete env.NO_COLOR;
  delete env.WHATSAPP_AGENT_WACLI_BIN;
  delete env.WHATSAPP_AGENT_CONFIG_DIR;
  delete env.WHATSAPP_AGENT_DATA_DIR;
  delete env.WHATSAPP_AGENT_LOG;
  return { ...env, FAKE_WACLI_FIXTURES: FIXTURES, ...extra };
}

/** The calls the fake logged. A log that was never written is an empty list; any other failure to read it is a problem with the test, so it is thrown. */
export async function readArgvLog(file: string): Promise<ArgvRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as ArgvRecord);
}
