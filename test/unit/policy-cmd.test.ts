import { mkdir, readFile, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentError } from '../../src/errors.js';
import { addFileRoot, allowRecipient, disableWrites, enableWrites, formatPolicy, isInertEntry, policyCommand, removeRecipient, setConfirm, setGroups, type PolicyCommandDeps } from '../../src/ops/policy-cmd.js';
import { DEFAULT_POLICY, loadPolicy, savePolicy } from '../../src/policy/schema.js';
import { createResolver, type Resolver } from '../../src/wacli/resolve.js';
import { createRunner } from '../../src/wacli/runner.js';
import { FAKE_WACLI, fakeEnv, fixturesWith, makeTmp, removeTmp } from '../helpers/fake.js';

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

  it('dedupes and removes by target, not by spelling, and refuses national numbers', async () => {
    await allowRecipient(file, '+61 400 000 001');
    await allowRecipient(file, '+61400000001');
    await allowRecipient(file, '+61400000002:3@s.whatsapp.net');
    await allowRecipient(file, '61400000002@s.whatsapp.net');
    expect((await loadPolicy(file)).writes.allow).toEqual(['+61 400 000 001', '61400000002@s.whatsapp.net']);
    await removeRecipient(file, '61400000002:9@s.whatsapp.net');
    await removeRecipient(file, '61400000001');
    expect((await loadPolicy(file)).writes.allow).toEqual([]);
    await expect(removeRecipient(file, 'nobody')).rejects.toMatchObject({ code: 'not_found' });
    await expect(allowRecipient(file, '0400 000 001')).rejects.toMatchObject({ code: 'invalid_input' });
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

  it('refuses the filesystem root and the home directory itself, but not a folder inside it', async () => {
    const sub = path.join(tmp, 'outbox');
    await mkdir(sub);
    vi.stubEnv('HOME', tmp);
    const message = 'Choose a directory inside your home, not the whole home directory.';
    for (const dir of ['/', '~', '~/', tmp, `${tmp}/`, path.join(tmp, '.'), path.join(sub, '..')]) {
      await expect(addFileRoot(file, dir), dir).rejects.toMatchObject({ code: 'invalid_input', message });
    }
    const link = path.join(tmp, 'home-link');
    await symlink(tmp, link);
    await expect(addFileRoot(file, link)).rejects.toMatchObject({ code: 'invalid_input', message });
    expect((await addFileRoot(file, '~/outbox')).writes.fileRoots).toEqual([await realpath(sub)]);
  });

  it('formats a readable summary and flags inert allowlist entries', async () => {
    await savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true, allow: ['+61 400 000 001', 'Alice'] } });
    const text = formatPolicy(await loadPolicy(file));
    expect(text).toContain('writes: enabled');
    expect(text).toContain('confirm: always');
    expect(text).toContain('Alice (inert: not a phone number or JID)');
    expect(isInertEntry('+61 400 000 001')).toBe(false);
    expect(isInertEntry('61400000001@S.WHATSAPP.NET')).toBe(false);
    expect(isInertEntry('0400 000 001')).toBe(true);
  });
});

describe('policy remove resolves names like allow', () => {
  /** A resolver over the fake wacli: Alice is a user chat, Family a group, and "a" matches both. */
  const fakeResolver = (): Resolver => createResolver(createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv() }));
  const mustNotResolve: Resolver = { resolve: async () => { throw new Error('the resolver must not be consulted'); } };
  const allowOf = async () => (await loadPolicy(file)).writes.allow;
  const seed = (allow: string[]) => savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, allow } });

  it('removes a name by looking it up the way allow does', async () => {
    await allowRecipient(file, 'Alice', fakeResolver());
    expect(await allowOf()).toEqual(['61400000001@s.whatsapp.net']);
    await removeRecipient(file, 'alice', fakeResolver());
    expect(await allowOf()).toEqual([]);
  });

  it('removes a phone entry by the name that resolves to the same person', async () => {
    await seed(['+61 400 000 001', '+61 400 000 002']);
    await removeRecipient(file, 'Alice', fakeResolver());
    expect(await allowOf()).toEqual(['+61 400 000 002']);
  });

  it('removes an inert text entry by its exact text, without wacli and without asking the resolver', async () => {
    await seed(['Alice', '61400000002@s.whatsapp.net']);
    await removeRecipient(file, 'alice', mustNotResolve);
    expect(await allowOf()).toEqual(['61400000002@s.whatsapp.net']);
    await seed(['Alice']);
    await removeRecipient(file, 'Alice');
    expect(await allowOf()).toEqual([]);
  });

  it('does not look up a phone number or a JID', async () => {
    await seed(['+61 400 000 001', '61400000002@s.whatsapp.net']);
    await removeRecipient(file, '61400000001', mustNotResolve);
    await removeRecipient(file, '61400000002:5@s.whatsapp.net', mustNotResolve);
    expect(await allowOf()).toEqual([]);
  });

  it('falls back to the text-only result when the lookup fails, and says not_found only when nothing matched', async () => {
    await seed(['61400000002@s.whatsapp.net']);
    const noWacli: Resolver = { resolve: async () => { throw new AgentError('wacli_not_installed', 'wacli was not found'); } };
    await expect(removeRecipient(file, 'Alice', noWacli)).rejects.toMatchObject({ code: 'not_found' });
    const nobody: Resolver = { resolve: async () => { throw new AgentError('not_found', 'No chat or contact matches "Zed".') ; } };
    await expect(removeRecipient(file, 'Zed', nobody)).rejects.toMatchObject({ code: 'not_found', message: '"Zed" is not on the allowlist.' });
    await expect(removeRecipient(file, 'Alice', fakeResolver())).rejects.toMatchObject({ code: 'not_found' });
    expect(await allowOf()).toEqual(['61400000002@s.whatsapp.net']);
  });

  it('lets an ambiguous name through so the command can list the candidates', async () => {
    await seed(['61400000001@s.whatsapp.net']);
    await expect(removeRecipient(file, 'a', fakeResolver())).rejects.toMatchObject({
      code: 'ambiguous_recipient',
      details: { candidates: [expect.objectContaining({ name: 'Family' }), expect.objectContaining({ name: 'Alice' })] },
    });
    expect(await allowOf()).toEqual(['61400000001@s.whatsapp.net']);
  });
});

/** Runs `whatsapp-agent policy <args>` in this process and returns what it printed and its exit code. */
async function runPolicy(args: string[], deps: PolicyCommandDeps): Promise<{ out: string; err: string; exitCode: number | string | undefined }> {
  let out = '';
  let err = '';
  const so = vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out += String(c); return true; });
  const se = vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err += String(c); return true; });
  const before = process.exitCode;
  process.exitCode = undefined;
  try {
    await policyCommand(deps).parseAsync(args, { from: 'user' });
    return { out, err, exitCode: process.exitCode };
  } finally {
    so.mockRestore();
    se.mockRestore();
    process.exitCode = before;
  }
}

/** Points the command at the temp policy file and, whatever a test forgets, at the fake wacli rather than the real one. */
function useTempPolicy(): void {
  vi.stubEnv('WHATSAPP_AGENT_CONFIG_DIR', path.dirname(file));
  vi.stubEnv('WHATSAPP_AGENT_WACLI_BIN', FAKE_WACLI);
}

describe('policy command output for an ambiguous name', () => {
  const deps = (): PolicyCommandDeps => ({ isTTY: () => true, makeResolver: () => createResolver(createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv() })) });
  const run = (args: string[]) => runPolicy(args, deps());

  beforeEach(useTempPolicy);

  it('prints the candidates with their JIDs and exits 1, for allow and for remove, changing nothing', async () => {
    await savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, allow: ['61400000009@s.whatsapp.net'] } });
    const expected = '"a" matches 2 chats or contacts. Pass the JID of the one you mean:\n  Family  120363000000000001@g.us\n  Alice  61400000001@s.whatsapp.net\n';
    for (const verb of ['allow', 'remove']) {
      const r = await run([verb, 'a']);
      expect(r.err).toBe(expected);
      expect(r.out).toBe('');
      expect(r.exitCode).toBe(1);
    }
    expect((await loadPolicy(file)).writes.allow).toEqual(['61400000009@s.whatsapp.net']);
  });

  it('counts every match when more than 10 matched, says the list was cut, and lists the first 10', async () => {
    const chat = (n: number) => ({ jid: `1203630000000${String(n).padStart(5, '0')}@g.us`, kind: 'group', name: `Zed ${n}`, last_message_ts: '2026-10-19T09:00:00Z', archived: false, pinned: false, muted_until: 0, unread: false, unread_count: 0 });
    const dir = await fixturesWith({ 'chats_list.json': JSON.stringify({ success: true, data: Array.from({ length: 14 }, (_, i) => chat(i + 1)), error: null }) });
    try {
      const many = (): PolicyCommandDeps => ({ isTTY: () => true, makeResolver: () => createResolver(createRunner({ bin: FAKE_WACLI, baseEnv: fakeEnv({ FAKE_WACLI_FIXTURES: dir }) })) });
      for (const verb of ['allow', 'remove']) {
        const r = await runPolicy([verb, 'zed'], many());
        const lines = r.err.trimEnd().split('\n');
        expect(lines[0]).toBe('"zed" matches 14 chats or contacts. Showing the first 10. Pass the JID of the one you mean:');
        expect(lines).toHaveLength(11);
        expect(lines[1]).toBe('  Zed 1  120363000000000001@g.us');
        expect(lines[10]).toBe('  Zed 10  120363000000000010@g.us');
        expect(r.exitCode).toBe(1);
      }
    } finally {
      await removeTmp(dir);
    }
  });

  it('allows and removes a name end to end through the command', async () => {
    let r = await run(['allow', 'Alice']);
    expect(r.exitCode).toBeUndefined();
    expect(r.out).toContain('allowlist: 61400000001@s.whatsapp.net');
    r = await run(['remove', 'Alice']);
    expect(r.exitCode).toBeUndefined();
    expect(r.out).toContain('allowlist: (empty)');
  });
});

describe('policy commands that widen what the agent may send need a terminal', () => {
  const REFUSAL = 'This command changes what the agent may send and must be run from an interactive terminal.\n';
  const noTerminal: PolicyCommandDeps = { isTTY: () => false };
  const terminal: PolicyCommandDeps = { isTTY: () => true };
  let outbox: string;

  beforeEach(async () => {
    useTempPolicy();
    outbox = path.join(tmp, 'outbox');
    await mkdir(outbox);
    await savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: true, confirm: 'unlisted', groups: true, allow: ['61400000009@s.whatsapp.net'] } });
  });

  const widening = (): string[][] => [['enable'], ['set', 'confirm', 'unlisted'], ['set', 'confirm', 'never'], ['set', 'groups', 'on'], ['allow', '+61 400 000 001'], ['add-file-root', outbox]];

  it('refuses each of them when stdin is not a terminal: it says why, exits 1 and changes nothing', async () => {
    await savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: false, confirm: 'always', groups: false } });
    const before = await readFile(file, 'utf8');
    for (const args of widening()) {
      const r = await runPolicy(args, noTerminal);
      expect({ args, err: r.err, out: r.out, exitCode: r.exitCode }).toEqual({ args, err: REFUSAL, out: '', exitCode: 1 });
    }
    expect(await readFile(file, 'utf8')).toBe(before);
  });

  it('runs each of them from a terminal', async () => {
    await savePolicy(file, { ...DEFAULT_POLICY, writes: { ...DEFAULT_POLICY.writes, enabled: false, confirm: 'always', groups: false } });
    for (const args of widening()) {
      const r = await runPolicy(args, terminal);
      expect({ args, err: r.err, exitCode: r.exitCode }).toEqual({ args, err: '', exitCode: undefined });
    }
    const p = await loadPolicy(file);
    expect(p.writes).toMatchObject({ enabled: true, confirm: 'never', groups: true, allow: ['+61 400 000 001'] });
    expect(p.writes.fileRoots).toEqual([await realpath(outbox)]);
  });

  it('leaves the commands that narrow or only read unrestricted', async () => {
    const free: string[][] = [['show'], ['set', 'confirm', 'always'], ['set', 'groups', 'off'], ['remove', '61400000009@s.whatsapp.net'], ['disable']];
    for (const args of free) {
      const r = await runPolicy(args, noTerminal);
      expect({ args, err: r.err, exitCode: r.exitCode }).toEqual({ args, err: '', exitCode: undefined });
    }
    const p = await loadPolicy(file);
    expect(p.writes).toMatchObject({ enabled: false, confirm: 'always', groups: false, allow: [] });
  });

  it('still reports a bad value as a bad value before it asks for a terminal', async () => {
    await expect(runPolicy(['set', 'confirm', 'sometimes'], noTerminal)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(runPolicy(['set', 'groups', 'maybe'], noTerminal)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('asks the real process.stdin when no seam is given', async () => {
    const before = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
    try {
      const r = await runPolicy(['enable'], {});
      expect(r.err).toBe(REFUSAL);
      expect(r.exitCode).toBe(1);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: before, configurable: true });
    }
  });
});
