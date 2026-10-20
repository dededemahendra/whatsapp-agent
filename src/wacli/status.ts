import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { AgentError } from '../errors.js';
import { meetsMinimum } from '../version.js';
import type { Runner } from './runner.js';
import { phoneFromJid, toIso, type WacliDoctor } from './shape.js';

/** wacli's version is read once per runner (so once per process) and cached, but only once it was read successfully. */
const versionCache = new WeakMap<Runner, string>();

export async function cachedVersion(runner: Runner): Promise<string | null> {
  const cached = versionCache.get(runner);
  if (cached !== undefined) return cached;
  const version = await runner.version();
  if (version !== null) versionCache.set(runner, version);
  return version;
}

export interface StatusInfo {
  wacli_version: string | null;
  min_version_ok: boolean;
  authenticated: boolean;
  phone: string | null;
  connection_state: string | null;
  session_revoked: boolean;
  store_dir: string | null;
  last_sync_at: string | null;
  heartbeat_at: string | null;
  heartbeat_age_seconds: number | null;
  counts: { chats: number | null; messages: number | null };
}

export async function readHeartbeat(file: string): Promise<Date | null> {
  try {
    const d = new Date((await readFile(file, 'utf8')).trim());
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

export async function getStatus(runner: Runner, now: Date): Promise<StatusInfo> {
  const version = await cachedVersion(runner);
  if (version !== null && !meetsMinimum(version)) {
    // An old wacli rejects the flags we send, so doctor would fail; report the version and nothing else.
    return {
      wacli_version: version, min_version_ok: false, authenticated: false, phone: null, connection_state: null, session_revoked: false,
      store_dir: null, last_sync_at: null, heartbeat_at: null, heartbeat_age_seconds: null, counts: { chats: null, messages: null },
    };
  }
  let doctor: WacliDoctor | null = null;
  let doctorError: AgentError | null = null;
  try {
    doctor = await runner.read<WacliDoctor>(['doctor']);
  } catch (e) {
    if (e instanceof AgentError && (e.code === 'not_authenticated' || e.code === 'session_logged_out')) doctorError = e;
    else throw e;
  }
  const storeDir = doctor?.store_dir ?? null;
  const heartbeat = storeDir ? await readHeartbeat(path.join(storeDir, 'HEARTBEAT')) : null;
  return {
    wacli_version: version,
    min_version_ok: meetsMinimum(version),
    authenticated: doctor?.authenticated ?? false,
    phone: phoneFromJid(doctor?.linked_jid),
    connection_state: doctor?.connection_state ?? doctorError?.code ?? null,
    session_revoked: doctor?.session_revoked ?? doctorError?.code === 'session_logged_out',
    store_dir: storeDir,
    last_sync_at: toIso(doctor?.store?.last_sync_at),
    heartbeat_at: heartbeat ? heartbeat.toISOString() : null,
    heartbeat_age_seconds: heartbeat ? Math.max(0, Math.floor((now.getTime() - heartbeat.getTime()) / 1000)) : null,
    counts: { chats: doctor?.store?.chats ?? null, messages: doctor?.store?.messages ?? null },
  };
}
