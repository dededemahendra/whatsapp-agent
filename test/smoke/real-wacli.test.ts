import { describe, expect, it } from 'vitest';
import { createRunner } from '../../src/wacli/runner.js';
import { asList, type WacliChat, type WacliContact, type WacliDoctor, type WacliGroup, type WacliMessagePage } from '../../src/wacli/shape.js';
import { getStatus } from '../../src/wacli/status.js';

const enabled = process.env.WHATSAPP_AGENT_SMOKE === '1';

describe.skipIf(!enabled)('real wacli (read-only)', () => {
  const runner = createRunner({ bin: process.env.WHATSAPP_AGENT_WACLI_BIN || 'wacli' });

  it('reports a paired store that meets the minimum version', async () => {
    const s = await getStatus(runner, new Date());
    expect(s.min_version_ok).toBe(true);
    expect(s.authenticated).toBe(true);
  });

  it('lists a few chats without writing anything', async () => {
    const doctor = await runner.read<WacliDoctor>(['doctor']);
    expect(doctor.store_dir).toBeTruthy();
    const chats = await runner.read<WacliChat[]>(['chats', 'list', '--limit=3']);
    expect(chats === null || Array.isArray(chats)).toBe(true);
  });

  // The checks below pin the keys the shapes in src/wacli/shape.ts read. A list may be null or empty on a quiet account;
  // then there is nothing to check, which is fine.

  it('returns message rows that carry ChatJID and MsgID', async () => {
    const page = await runner.read<WacliMessagePage | null>(['messages', 'list', '--limit=1']);
    for (const row of asList(page?.messages)) {
      expect(typeof row.ChatJID).toBe('string');
      expect(typeof row.MsgID).toBe('string');
    }
  });

  it('returns contact rows that carry jid and name', async () => {
    const rows = asList(await runner.read<WacliContact[] | null>(['contacts', 'search', '--limit=1', '--', 'a']));
    for (const row of rows) {
      expect(typeof row.jid).toBe('string');
      expect(row).toHaveProperty('name');
    }
  });

  it('returns group rows that carry JID and Name', async () => {
    const rows = asList(await runner.read<WacliGroup[] | null>(['groups', 'list']));
    for (const row of rows) {
      expect(typeof row.JID).toBe('string');
      expect(row).toHaveProperty('Name');
    }
  });

  it('returns a doctor report that carries store_dir', async () => {
    const doctor = await runner.read<WacliDoctor>(['doctor']);
    expect(typeof doctor.store_dir).toBe('string');
  });
});
