import { AgentError } from '../errors.js';
import type { Runner } from './runner.js';
import { asList, kindFromJid, kindFromWacli, nonEmpty, type ChatKind, type WacliChat, type WacliContact, type WacliResolution } from './shape.js';

export interface Resolved { jid: string; name: string | null; kind: ChatKind }
export interface Resolver { resolve(input: string): Promise<Resolved> }

export const JID_RE = /^[^@\s]+@(s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)$/;

export function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

/** An optional single leading plus, then digits with spaces, dashes or parentheses, 6 to 15 digits in all. */
export function looksLikePhone(s: string): boolean {
  const t = s.trim();
  const n = digitsOf(t).length;
  return /^\+?[\d\s()\-]+$/.test(t) && n >= 6 && n <= 15;
}

/** Strips a leading + and a :device suffix from user JIDs so one person has one spelling. */
export function canonicalJid(jid: string): string {
  if (!jid.endsWith('@s.whatsapp.net')) return jid;
  const user = (jid.split('@')[0] ?? '').replace(/^\+/, '').split(':')[0] ?? '';
  return `${user}@s.whatsapp.net`;
}

export type PickResult = { kind: 'none' } | { kind: 'one'; value: Resolved } | { kind: 'many'; candidates: Resolved[] };

export function pickUnique(candidates: Resolved[], input: string): PickResult {
  if (candidates.length === 0) return { kind: 'none' };
  const needle = input.trim().toLowerCase();
  const exact = candidates.filter((c) => (c.name ?? '').trim().toLowerCase() === needle);
  if (exact.length === 1) return { kind: 'one', value: exact[0]! };
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return (only.name ?? '').toLowerCase().includes(needle) ? { kind: 'one', value: only } : { kind: 'none' };
  }
  return { kind: 'many', candidates: candidates.slice(0, 10) };
}

function ambiguous(input: string, candidates: Resolved[]): AgentError {
  return new AgentError('ambiguous_recipient',
    `"${input}" matches ${candidates.length} chats or contacts. Ask the person which one, or pass the JID.`,
    { candidates });
}

export function createResolver(runner: Runner): Resolver {
  async function byJid(input: string): Promise<Resolved> {
    const jid = canonicalJid(input);
    const chats = asList(await runner.read<WacliChat[] | null>(['chats', 'list', `--query=${jid}`, '--limit=5']));
    const hit = chats.find((c) => c.jid === jid);
    return { jid, name: hit ? nonEmpty(hit.name) : null, kind: hit ? kindFromWacli(hit.kind, jid) : kindFromJid(jid) };
  }

  async function byPhone(input: string): Promise<Resolved> {
    const digits = digitsOf(input);
    if (digits.startsWith('0')) {
      throw new AgentError('invalid_input', `"${input.trim()}" looks like a national number. Use the international format with the country code, for example +61 400 000 001.`);
    }
    const results = asList(await runner.read<WacliResolution[] | null>(['contacts', 'resolve', '--', digits]));
    const r = results[0];
    if (r && r.resolved && r.jid) return { jid: canonicalJid(r.jid), name: nonEmpty(r.name), kind: 'user' };
    return { jid: `${digits}@s.whatsapp.net`, name: null, kind: 'user' };
  }

  async function byName(input: string): Promise<Resolved> {
    const chats = asList(await runner.read<WacliChat[] | null>(['chats', 'list', `--query=${input}`, '--limit=10']));
    const fromChats = pickUnique(chats.map((c) => ({ jid: c.jid, name: nonEmpty(c.name), kind: kindFromWacli(c.kind, c.jid) })), input);
    if (fromChats.kind === 'one') return fromChats.value;
    if (fromChats.kind === 'many') throw ambiguous(input, fromChats.candidates);

    const contacts = asList(await runner.read<WacliContact[] | null>(['contacts', 'search', '--limit=10', '--', input]));
    const fromContacts = pickUnique(contacts.map((c) => ({ jid: canonicalJid(c.jid), name: nonEmpty(c.name) ?? nonEmpty(c.alias), kind: 'user' as const })), input);
    if (fromContacts.kind === 'one') return fromContacts.value;
    if (fromContacts.kind === 'many') throw ambiguous(input, fromContacts.candidates);
    throw new AgentError('not_found', `No chat or contact matches "${input}". Pass a phone number or JID.`);
  }

  return {
    async resolve(input: string): Promise<Resolved> {
      const s = input.trim();
      if (s === '') throw new AgentError('invalid_input', 'Recipient must not be empty.');
      if (JID_RE.test(s)) return byJid(s);
      if (looksLikePhone(s)) return byPhone(s);
      return byName(s);
    },
  };
}
