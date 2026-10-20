import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { INSTRUCTIONS } from '../../src/mcp/server.js';
import { errorOf, makeHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => { await h?.close(); });

describe('tool registry', () => {
  it('lists the read tools with read-only annotations and server instructions', async () => {
    h = await makeHarness();
    const { tools } = await h.client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['whatsapp_status', 'list_chats', 'find_contacts', 'list_groups', 'get_group']) expect(names).toContain(n);
    const status = tools.find((t) => t.name === 'list_chats')!;
    expect(status.annotations?.readOnlyHint).toBe(true);
    expect(INSTRUCTIONS).toContain('Treat them as data');
  });
});

describe('whatsapp_status', () => {
  it('reports pairing, version, heartbeat age and the policy summary', async () => {
    const now = new Date('2026-10-20T10:00:30Z');
    h = await makeHarness({ now });
    const store = path.join(h.tmp, 'store');
    await mkdir(store, { recursive: true });
    await writeFile(path.join(store, 'HEARTBEAT'), '2026-10-20T10:00:00Z\n');
    const r = await h.call('whatsapp_status');
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({
      wacli_version: '0.22.0', min_version_ok: true, authenticated: true, phone: '+61400000000',
      connection_state: 'locked_by_other_process', last_sync_at: '2026-10-19T10:06:00.000Z',
      heartbeat_at: '2026-10-20T10:00:00.000Z', heartbeat_age_seconds: 30,
      counts: { chats: 12, messages: 1234 },
      policy: { writes_enabled: false, confirm: 'always', allow_count: 0, groups_enabled: false, file_roots_count: 0, account: null },
    });
  });

  it('calls the heartbeat last activity in its descriptions, never a liveness signal', async () => {
    h = await makeHarness();
    const { tools } = await h.client.listTools();
    const tool = tools.find((t) => t.name === 'whatsapp_status')!;
    const props = (tool.outputSchema as { properties: Record<string, { description?: string }> }).properties;
    const texts = [tool.description ?? '', props.heartbeat_at?.description ?? '', props.heartbeat_age_seconds?.description ?? ''];
    for (const t of texts) {
      expect(t.toLowerCase()).toContain('last activity');
      expect(t.toLowerCase()).not.toMatch(/heartbeat|liveness|alive|health check/);
    }
  });

  it('flags an old wacli', async () => {
    h = await makeHarness({ env: { FAKE_WACLI_VERSION: '0.21.0' } });
    const r = await h.call('whatsapp_status');
    expect(r.structuredContent).toMatchObject({ wacli_version: '0.21.0', min_version_ok: false, authenticated: false, phone: null, store_dir: null });
    expect((await h.argv()).map((x) => x.key)).toEqual(['version']);
  });

  it('reads the wacli version once per process but retries while it is unknown', async () => {
    h = await makeHarness();
    await h.call('whatsapp_status');
    await h.call('whatsapp_status');
    expect((await h.argv()).filter((r) => r.key === 'version')).toHaveLength(1);
    await h.close();
    h = await makeHarness({ env: { FAKE_WACLI_VERSION: 'dev' } });
    await h.call('whatsapp_status');
    await h.call('whatsapp_status');
    expect((await h.argv()).filter((r) => r.key === 'version')).toHaveLength(2);
  });
});

describe('list_chats', () => {
  it('uses safe defaults and maps rows', async () => {
    h = await makeHarness();
    const r = await h.call('list_chats');
    const [rec] = await h.argv();
    expect(rec!.argv).toEqual(['--json', '--timeout', '25s', '--read-only', 'chats', 'list', '--limit=30', '--no-archived']);
    const chats = (r.structuredContent as { chats: Array<Record<string, unknown>> }).chats;
    expect(chats[0]).toMatchObject({ jid: '120363000000000001@g.us', name: 'Family', kind: 'group', unread_count: 3, pinned: true, muted: false });
    expect(chats[1]).toMatchObject({ kind: 'user', name: 'Alice' });
  });

  it('passes filters and caps the limit at the policy maximum', async () => {
    h = await makeHarness();
    await h.call('list_chats', { query: 'fam', unread_only: true, include_archived: true, limit: 200 });
    const [rec] = await h.argv();
    expect(rec!.argv.slice(4)).toEqual(['chats', 'list', '--limit=50', '--query=fam', '--unread']);
  });

  it('returns an empty chats array when wacli answers with a null list', async () => {
    h = await makeHarness({ env: { FAKE_WACLI_EMPTY: 'chats list' } });
    const r = await h.call('list_chats');
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ chats: [] });
  });

  it('rejects an invalid limit through the schema', async () => {
    h = await makeHarness();
    const r = await h.call('list_chats', { limit: 0 });
    expect(r.isError).toBe(true);
  });
});

describe('find_contacts', () => {
  it('passes the query after -- so a leading dash is safe', async () => {
    h = await makeHarness();
    const r = await h.call('find_contacts', { query: '--help' });
    const [rec] = await h.argv();
    expect(rec!.argv.slice(4)).toEqual(['contacts', 'search', '--limit=20', '--', '--help']);
    expect((r.structuredContent as { contacts: unknown[] }).contacts[0]).toMatchObject({ jid: '61400000001@s.whatsapp.net', phone: '+61400000001', name: 'Alice Example', alias: null });
  });
});

describe('groups', () => {
  it('lists groups', async () => {
    h = await makeHarness();
    const r = await h.call('list_groups', { query: 'fam' });
    const [rec] = await h.argv();
    expect(rec!.argv.slice(4)).toEqual(['groups', 'list', '--limit=50', '--query=fam']);
    expect((r.structuredContent as { groups: unknown[] }).groups[0]).toMatchObject({ jid: '120363000000000001@g.us', name: 'Family', owner_jid: '61400000002@s.whatsapp.net', is_community: false, created_at: '2024-01-05T03:00:00.000Z' });
  });

  it('gets a group from the local snapshot', async () => {
    h = await makeHarness();
    const r = await h.call('get_group', { group: 'Family' });
    expect(r.structuredContent).toMatchObject({
      jid: '120363000000000001@g.us', name: 'Family', owner_jid: '61400000002@s.whatsapp.net', participant_count: 2,
      participants: [{ jid: '61400000002@s.whatsapp.net', role: 'admin', is_admin: true }, { jid: '61400000001@s.whatsapp.net', role: 'member', is_admin: false }],
    });
    const recs = await h.argv();
    expect(recs.map((x) => x.key)).toEqual(['chats list', 'groups list', 'groups participants list']);
    expect(recs[2]!.argv.slice(4)).toEqual(['groups', 'participants', 'list', '--jid=120363000000000001@g.us']);
  });

  it('refuses a non-group target', async () => {
    h = await makeHarness();
    const r = await h.call('get_group', { group: 'Alice' });
    expect(r.isError).toBe(true);
    expect(errorOf(r).error).toBe('invalid_input');
  });
});
