import { AgentError } from '../errors.js';
import type { Runner } from './runner.js';
import { asList, kindFromJid, kindFromWacli, nonEmpty, type ChatKind, type WacliChat, type WacliContact, type WacliResolution } from './shape.js';

export interface Resolved { jid: string; name: string | null; kind: ChatKind }
/** `exact` is for writes: a name is accepted only on an exact match, never on a lone partial one. */
export interface ResolveOptions { exact?: boolean }
export interface Resolver { resolve(input: string, opts?: ResolveOptions): Promise<Resolved> }

const USER_DOMAIN = '@s.whatsapp.net';
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

export type MatchField = 'name' | 'alias' | 'system_name';
/** What pickUnique takes: a resolution plus, for contacts, the other names it answers to. */
export type Matchable = Resolved & { alias?: string | null; system_name?: string | null };
/** A candidate in an ambiguous_recipient error. `matched_on` says which name matched, and appears for contacts only. */
export type Candidate = Resolved & { matched_on?: MatchField };
/** `partial` appears only in exact mode: the one candidate that contains the input without matching it exactly. */
export type PickResult =
  | { kind: 'none' }
  | { kind: 'one'; value: Resolved }
  | { kind: 'partial'; candidate: Candidate }
  | { kind: 'many'; candidates: Candidate[] };

/** Case-insensitive, trimmed and NFC-normalised, so the same name typed in another Unicode form still matches. */
const fold = (s: string): string => s.trim().normalize('NFC').toLowerCase().normalize('NFC');

/** The names a candidate answers to, folded: its display name first, then alias and system name. */
function namesOf(c: Matchable): Array<[MatchField, string]> {
  const fields: Array<[MatchField, string | null | undefined]> = [['name', c.name], ['alias', c.alias], ['system_name', c.system_name]];
  const names: Array<[MatchField, string]> = [];
  for (const [field, value] of fields) {
    const v = fold(value ?? '');
    if (v !== '') names.push([field, v]);
  }
  return names;
}

const plain = (c: Matchable): Resolved => ({ jid: c.jid, name: c.name, kind: c.kind });

/** Contacts get a label naming the field that matched: an exact match first, else the first name that contains the input. */
function labelled(c: Matchable, needle: string): Candidate {
  if (c.alias === undefined && c.system_name === undefined) return plain(c);
  const names = namesOf(c);
  const hit = names.find(([, v]) => v === needle) ?? names.find(([, v]) => v.includes(needle));
  return hit ? { ...plain(c), matched_on: hit[0] } : plain(c);
}

export function pickUnique(candidates: Matchable[], input: string, opts: ResolveOptions = {}): PickResult {
  if (candidates.length === 0) return { kind: 'none' };
  const needle = fold(input);
  const exact = candidates.filter((c) => namesOf(c).some(([, v]) => v === needle));
  if (exact.length === 1) return { kind: 'one', value: plain(exact[0]!) };
  if (candidates.length === 1) {
    const only = candidates[0]!;
    if (!namesOf(only).some(([, v]) => v.includes(needle))) return { kind: 'none' };
    return opts.exact ? { kind: 'partial', candidate: labelled(only, needle) } : { kind: 'one', value: plain(only) };
  }
  return { kind: 'many', candidates: candidates.slice(0, 10).map((c) => labelled(c, needle)) };
}

function ambiguous(input: string, candidates: Candidate[]): AgentError {
  return new AgentError('ambiguous_recipient',
    `"${input}" matches ${candidates.length} chats or contacts. Ask the person which one, or pass the JID.`,
    { candidates });
}

function notExactly(input: string, candidates: Candidate[]): AgentError {
  return new AgentError('ambiguous_recipient', `No chat or contact is named exactly "${input}". Use the exact name or the JID.`, { candidates });
}

export function createResolver(runner: Runner): Resolver {
  async function byJid(input: string): Promise<Resolved> {
    const jid = canonicalJid(input);
    const user = jid.endsWith(USER_DOMAIN) ? jid.slice(0, -USER_DOMAIN.length) : null;
    if (user !== null && !/^\d{6,15}$/.test(user)) {
      throw new AgentError('invalid_input', `"${input}" is not a valid WhatsApp number: the part before @ must be 6 to 15 digits.`);
    }
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

  async function byName(input: string, exact: boolean): Promise<Resolved> {
    const partials: Candidate[] = [];

    const chats = asList(await runner.read<WacliChat[] | null>(['chats', 'list', `--query=${input}`, '--limit=50']));
    const fromChats = pickUnique(chats.map((c) => ({ jid: c.jid, name: nonEmpty(c.name), kind: kindFromWacli(c.kind, c.jid) })), input, { exact });
    if (fromChats.kind === 'one') return fromChats.value;
    if (fromChats.kind === 'many') throw ambiguous(input, fromChats.candidates);
    if (fromChats.kind === 'partial') partials.push(fromChats.candidate);

    // An exact contact still wins over a lone partial chat, so the contacts are searched either way.
    const contacts = asList(await runner.read<WacliContact[] | null>(['contacts', 'search', '--limit=50', '--', input]));
    const fromContacts = pickUnique(contacts.map((c) => ({
      jid: canonicalJid(c.jid), name: nonEmpty(c.name) ?? nonEmpty(c.alias), kind: 'user' as const, alias: nonEmpty(c.alias), system_name: nonEmpty(c.system_name),
    })), input, { exact });
    if (fromContacts.kind === 'one') return fromContacts.value;
    if (fromContacts.kind === 'many') throw ambiguous(input, fromContacts.candidates);
    if (fromContacts.kind === 'partial' && !partials.some((p) => p.jid === fromContacts.candidate.jid)) partials.push(fromContacts.candidate);

    if (partials.length > 0) throw notExactly(input, partials);
    throw new AgentError('not_found', `No chat or contact matches "${input}". Pass a phone number or JID.`);
  }

  return {
    async resolve(input: string, opts: ResolveOptions = {}): Promise<Resolved> {
      const s = input.trim();
      if (s === '') throw new AgentError('invalid_input', 'Recipient must not be empty.');
      if (JID_RE.test(s)) return byJid(s);
      if (looksLikePhone(s)) return byPhone(s);
      return byName(s, opts.exact === true);
    },
  };
}
