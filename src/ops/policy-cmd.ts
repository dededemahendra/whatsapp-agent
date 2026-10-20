import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { AgentError } from '../errors.js';
import { resolvePaths } from '../paths.js';
import { sameAllowTarget } from '../policy/engine.js';
import { loadPolicy, savePolicy, type ConfirmMode, type Policy } from '../policy/schema.js';
import { canonicalJid, createResolver, digitsOf, JID_RE, looksLikePhone, type Resolver } from '../wacli/resolve.js';
import { createRunner } from '../wacli/runner.js';

async function edit(file: string, fn: (p: Policy) => Policy): Promise<Policy> {
  const next = fn(await loadPolicy(file));
  await savePolicy(file, next);
  return next;
}

export const enableWrites = (file: string) => edit(file, (p) => ({ ...p, writes: { ...p.writes, enabled: true } }));
export const disableWrites = (file: string) => edit(file, (p) => ({ ...p, writes: { ...p.writes, enabled: false } }));

/** True when an allowlist entry is neither a phone number (international format) nor a JID, so it can never match (A18). */
export function isInertEntry(entry: string): boolean {
  const e = entry.trim();
  return !(JID_RE.test(e.toLowerCase()) || (looksLikePhone(e) && !digitsOf(e).startsWith('0')));
}

/** Phone numbers are stored as given, JIDs canonicalised; a name is resolved once through wacli and stored as its JID. */
export async function allowRecipient(file: string, entry: string, resolver?: Resolver): Promise<Policy> {
  const e = entry.trim();
  let stored: string;
  if (JID_RE.test(e.toLowerCase())) {
    stored = canonicalJid(e.toLowerCase());
  } else if (looksLikePhone(e)) {
    if (digitsOf(e).startsWith('0')) {
      throw new AgentError('invalid_input', `"${e}" looks like a national number. Use the international format with the country code, for example +61 400 000 001.`);
    }
    stored = e;
  } else {
    if (!resolver) throw new AgentError('invalid_input', `"${e}" is not a phone number or JID. Names are looked up through wacli; pass the number or JID instead.`);
    const r = await resolver.resolve(e);
    if (r.kind !== 'user' && r.kind !== 'group') throw new AgentError('invalid_input', `"${e}" is a ${r.kind}, which cannot receive messages.`);
    stored = canonicalJid(r.jid);
  }
  return edit(file, (p) => (p.writes.allow.some((a) => sameAllowTarget(a, stored))
    ? p
    : { ...p, writes: { ...p.writes, allow: [...p.writes.allow, stored] } }));
}

export const removeRecipient = (file: string, entry: string) => edit(file, (p) => {
  const kept = p.writes.allow.filter((a) => !sameAllowTarget(a, entry));
  if (kept.length === p.writes.allow.length) throw new AgentError('not_found', `"${entry.trim()}" is not on the allowlist.`);
  return { ...p, writes: { ...p.writes, allow: kept } };
});

export const setConfirm = (file: string, mode: ConfirmMode) => edit(file, (p) => ({ ...p, writes: { ...p.writes, confirm: mode } }));
export const setGroups = (file: string, on: boolean) => edit(file, (p) => ({ ...p, writes: { ...p.writes, groups: on } }));

export async function addFileRoot(file: string, dir: string): Promise<Policy> {
  const expanded = dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir;
  const abs = path.resolve(expanded);
  let real: string;
  try {
    real = await realpath(abs);
    if (!(await stat(real)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new AgentError('invalid_input', `${abs} is not an existing directory`);
  }
  return edit(file, (p) => (p.writes.fileRoots.includes(real) ? p : { ...p, writes: { ...p.writes, fileRoots: [...p.writes.fileRoots, real] } }));
}

export function formatPolicy(p: Policy): string {
  const allow = p.writes.allow.map((a) => (isInertEntry(a) ? `${a} (inert: not a phone number or JID)` : a));
  return [
    `writes: ${p.writes.enabled ? 'enabled' : 'disabled'}`,
    `confirm: ${p.writes.confirm}`,
    `allowlist: ${allow.length === 0 ? '(empty)' : allow.join(', ')}`,
    `groups: ${p.writes.groups ? 'on' : 'off'}`,
    `rate limit: ${p.writes.rateLimit.perHour} per hour, ${p.writes.rateLimit.minGapSeconds}s minimum gap`,
    `file roots: ${p.writes.fileRoots.length === 0 ? '(none; send_file is off)' : p.writes.fileRoots.join(', ')}`,
    `account: ${p.account ?? '(default wacli store)'}`,
  ].join('\n') + '\n';
}

export function policyCommand(): Command {
  const file = () => resolvePaths().policyFile;
  const out = (p: Policy): void => { process.stdout.write(formatPolicy(p)); };
  const cmd = new Command('policy').description('Show or change what the agent may send');
  cmd.command('show').description('Print the current policy').action(async () => out(await loadPolicy(file())));
  cmd.command('enable').description('Allow write tools (sends still follow confirm, allowlist and rate limit)').action(async () => out(await enableWrites(file())));
  cmd.command('disable').description('Turn all write tools off').action(async () => out(await disableWrites(file())));
  cmd.command('allow <recipient>').description('Add a phone number or JID to the allowlist; a name is looked up once and stored as its JID').action(async (r: string) => {
    const policy = await loadPolicy(file());
    const resolver = createResolver(createRunner({ bin: process.env.WHATSAPP_AGENT_WACLI_BIN || 'wacli', account: policy.account, baseEnv: process.env }));
    out(await allowRecipient(file(), r, resolver));
  });
  cmd.command('remove <recipient>').description('Remove an allowlist entry').action(async (r: string) => out(await removeRecipient(file(), r)));
  const set = cmd.command('set').description('Change a setting');
  set.command('confirm <mode>').description('always | unlisted | never').action(async (mode: string) => {
    if (mode !== 'always' && mode !== 'unlisted' && mode !== 'never') throw new AgentError('invalid_input', 'mode must be always, unlisted or never');
    out(await setConfirm(file(), mode));
  });
  set.command('groups <on|off>').description('Allow sends to groups').action(async (v: string) => {
    if (v !== 'on' && v !== 'off') throw new AgentError('invalid_input', 'value must be on or off');
    out(await setGroups(file(), v === 'on'));
  });
  cmd.command('add-file-root <dir>').description('Allow send_file to read files under this directory').action(async (dir: string) => out(await addFileRoot(file(), dir)));
  return cmd;
}
