import { describe, expect, it } from 'vitest';
import type { Runner } from '../../src/wacli/runner.js';
import { getStatus } from '../../src/wacli/status.js';

function stub(version: string | null, onRead: (args: string[]) => unknown): { runner: Runner; reads: string[][] } {
  const reads: string[][] = [];
  const runner: Runner = {
    bin: 'stub-wacli',
    read: (async (args: string[]) => { reads.push(args); return onRead(args); }) as Runner['read'],
    write: async () => { throw new Error('status must not write'); },
    version: async () => version,
  };
  return { runner, reads };
}

describe('getStatus', () => {
  it('returns a below-minimum status without running doctor when the version is known and too old', async () => {
    const s = stub('0.21.0', () => { throw new Error('doctor must not run'); });
    expect(await getStatus(s.runner, new Date('2026-10-20T10:00:00Z'))).toEqual({
      wacli_version: '0.21.0', min_version_ok: false, authenticated: false, phone: null, connection_state: null, session_revoked: false,
      store_dir: null, last_sync_at: null, heartbeat_at: null, heartbeat_age_seconds: null, counts: { chats: null, messages: null },
    });
    expect(s.reads).toEqual([]);
  });

  it('still runs doctor when the version cannot be read', async () => {
    const s = stub(null, () => ({ authenticated: true, session_revoked: false, linked_jid: '61400000000:7@s.whatsapp.net', connection_state: 'ok' }));
    const status = await getStatus(s.runner, new Date('2026-10-20T10:00:00Z'));
    expect(s.reads).toEqual([['doctor']]);
    expect(status).toMatchObject({ wacli_version: null, min_version_ok: false, authenticated: true, phone: '+61400000000', connection_state: 'ok' });
  });
});
