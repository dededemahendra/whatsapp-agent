import { AgentError } from '../errors.js';
import type { Runner } from './runner.js';
import { kindFromJid, kindFromWacli, nonEmpty, type ChatKind, type WacliChat, type WacliContact, type WacliResolution } from './shape.js';

export interface Resolved { jid: string; name: string | null; kind: ChatKind }
export interface Resolver { resolve(input: string): Promise<Resolved> }

export const JID_RE = /^[^@\s]+@(s\.whatsapp\.net|g\.us|lid|newsletter|broadcast)$/;

export function digitsOf(s: string): string {
  return s.replace(/\D/g, '');
}

export function looksLikePhone(s: string): boolean {
  const t = s.trim();
  return /^[+\d\s()\-]+$/.test(t) && digitsOf(t).length >= 6;
}

export type Pick = { kind: 'none' } | { kind: 'one'; value: Resolved } | { kind: 'many'; candidates: Resolved[] };

export function pickUnique(candidates: Resolved[], input: string): Pick {
  if (candidates.length === 0) return { kind: 'none' };
  const needle = input.trim().toLowerCase();
  const exact = candidates.filter((c) => (c.name ?? '').toLowerCase() === needle);
  if (exact.length === 1) return { kind: 'one', value: exact[0]! };
  if (candidates.length === 1) return { kind: 'one', value: candidates[0]! };
  return { kind: 'many', candidates: candidates.slice(0, 10) };
}

function ambiguous(input: string, candidates: Resolved[]): AgentError {
  return new AgentError('ambiguous_recipient',
    `"${input}" matches ${candidates.length} chats or contacts. Ask the person which one, or pass the JID.`,
    { candidates });
}

export function createResolver(runner: Runner): Resolver {
  async function byJid(jid: string): Promise<Resolved> {
    const chats = await runner.read<WacliChat[]>(['chats', 'list', `--query=${jid}`, '--limit=5']);
    const hit = chats.find((c) => c.jid === jid);
    return { jid, name: hit ? nonEmpty(hit.name) : null, kind: hit ? kindFromWacli(hit.kind, jid) : kindFromJid(jid) };
  }

  async function byPhone(input: string): Promise<Resolved> {
    const digits = digitsOf(input);
    const results = await runner.read<WacliResolution[]>(['contacts', 'resolve', '--', digits]);
    const r = results[0];
    if (r && r.resolved && r.jid) return { jid: r.jid, name: nonEmpty(r.name), kind: 'user' };
    return { jid: `${digits}@s.whatsapp.net`, name: null, kind: 'user' };
  }

  async function byName(input: string): Promise<Resolved> {
    const chats = await runner.read<WacliChat[]>(['chats', 'list', `--query=${input}`, '--limit=10']);
    const fromChats = pickUnique(chats.map((c) => ({ jid: c.jid, name: nonEmpty(c.name), kind: kindFromWacli(c.kind, c.jid) })), input);
    if (fromChats.kind === 'one') return fromChats.value;
    if (fromChats.kind === 'many') throw ambiguous(input, fromChats.candidates);

    const contacts = await runner.read<WacliContact[]>(['contacts', 'search', '--limit=10', '--', input]);
    const fromContacts = pickUnique(contacts.map((c) => ({ jid: c.jid, name: nonEmpty(c.name) ?? nonEmpty(c.alias), kind: 'user' as const })), input);
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
