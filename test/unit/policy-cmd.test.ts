import { mkdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addFileRoot, allowRecipient, disableWrites, enableWrites, formatPolicy, isInertEntry, removeRecipient, setConfirm, setGroups } from '../../src/ops/policy-cmd.js';
import { DEFAULT_POLICY, loadPolicy, savePolicy } from '../../src/policy/schema.js';
import type { Resolver } from '../../src/wacli/resolve.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';

let tmp: string;
let file: string;
beforeEach(async () => { tmp = await makeTmp(); file = path.join(tmp, 'cfg', 'policy.json'); });
afterEach(async () => { await removeTmp(tmp); vi.unstubAllEnvs(); });

const alice: Resolver = { resolve: async () => ({ jid: '61400000001@s.whatsapp.net', name: 'Alice', kind: 'user' }) };
const channel: Resolver = { resolve: async () => ({ jid: '1@newsletter', name: 'News', kind: 'channel' }) };

describe('policy edits', () => {
  it('enables and disables writes, persisting to disk', async () => {
    expect((await enableWrites(file)).writes.enabled).toBe(true);
    expect((await loadPolicy(file)).writes.enabled).toBe(true);
    expect((await disableWrites(file)).writes.enabled).toBe(false);
  });

  it('stores phone numbers as given, canonicalises JIDs, and dedupes', async () => {
    await allowRecipient(file, '+61 400 000 001');
    await allowRecipient(file, '+61 400 000 001');
    await allowRecipient(file, '+61400000002:3@s.whatsapp.net');
    await allowRecipient(file, '61400000002@s.whatsapp.net');
    expect((await loadPolicy(file)).writes.allow).toEqual(['+61 400 000 001', '61400000002@s.whatsapp.net']);
    await removeRecipient(file, '61400000002:9@s.whatsapp.net');
    expect((await loadPolicy(file)).writes.allow).toEqual(['+61 400 000 001']);
  });

  it('resolves a name to its JID once and refuses names without a resolver or unsendable kinds', async () => {
    await allowRecipient(file, 'Alice', alice);
    expect((await loadPolicy(file)).writes.allow).toEqual(['61400000001@s.whatsapp.net']);
    await expect(allowRecipient(file, 'Bob')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(allowRecipient(file, 'News', channel)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('sets confirm mode and groups', async () => {
    expect((await setConfirm(file, 'unlisted')).writes.confirm).toBe('unlisted');
    expect((await setGroups(file, true)).writes.groups).toBe(true);
  });

  it('adds an existing directory as a file root, resolved to a real absolute path, expanding a leading tilde', async () => {
    const dir = path.join(tmp, 'outbox');
    await mkdir(dir);
    vi.stubEnv('HOME', tmp);
    const p = await addFileRoot(file, '~/outbox');
    expect(p.writes.fileRoots).toEqual([await realpath(dir)]);
    await expect(addFileRoot(file, path.join(tmp, 'missing'))).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('formats a readable summary and flags inert allowlist entries', async () => {
    await savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true, allow: ['+61 400 000 001', 'Alice'] } });
    const text = formatPolicy(await loadPolicy(file));
    expect(text).toContain('writes: enabled');
    expect(text).toContain('confirm: always');
    expect(text).toContain('Alice (inert: not a phone number or JID)');
    expect(isInertEntry('+61 400 000 001')).toBe(false);
  });
});
