import { createHash, randomBytes } from 'node:crypto';
import {
  acceptedContent, CLIENT_CAPABILITIES_META_KEY, createRequestStateCodec, inputRequired, inputResponse,
  type InputRequiredResult, type McpServer, type RequestStateAccessor, type RequestStateCodec,
} from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Answer } from '../policy/engine.js';
import type { Resolved } from '../wacli/resolve.js';
import type { ChatKind } from '../wacli/shape.js';

/** The slice of the SDK handler context this module reads. Structural, so any ServerContext fits. */
export interface HandlerCtx {
  mcpReq: { envelope?: unknown; inputResponses?: Record<string, unknown>; requestState: RequestStateAccessor };
}

interface CapsView { elicitation?: { form?: unknown; url?: unknown } }

export const ConfirmSchema = z.object({ confirm: z.boolean().meta({ title: 'Yes, send it' }) });

/** The first protocol revision whose requests carry the client's capabilities in their own `_meta` envelope. */
const FIRST_ENVELOPE_REVISION = '2026-07-28';

/** Form elicitation is supported when `form` is declared, or when `elicitation` is a bare declaration (2025 rule). */
export function elicitationSupportsForm(caps: unknown): boolean {
  if (!caps || typeof caps !== 'object') return false;
  const e = (caps as CapsView).elicitation;
  if (!e || typeof e !== 'object') return false;
  if (e.form !== undefined) return true;
  return e.url === undefined;
}

/**
 * Whether the connected client can show a confirmation form. A 2026-07-28 request declares its capabilities in its own envelope; a
 * 2025-era connection declared them once at initialize, and the SDK ignores any `_meta` claim there, so this does too.
 */
export function clientCanConfirm(server: McpServer, ctx: HandlerCtx): boolean {
  const revision = server.server.getNegotiatedProtocolVersion();
  if (revision !== undefined && revision >= FIRST_ENVELOPE_REVISION) {
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    return elicitationSupportsForm(envelope?.[CLIENT_CAPABILITIES_META_KEY]);
  }
  return elicitationSupportsForm(server.server.getClientCapabilities());
}

/** Controls that carry no whitespace meaning: C0 without tab, line feed, vertical tab, form feed and carriage return, plus DEL and C1 without NEL. */
const CONTROLS = /[\u0000-\u0008\u000e-\u001f\u007f-\u0084\u0086-\u009f]/g;
/** Characters that change how text is drawn without being visible: bidi marks, isolates and overrides, zero-width characters and the byte order mark. */
const INVISIBLES = /[\u061c\u200b-\u200f\u2060\u2066-\u2069\u202a-\u202e\ufeff]/g;
const SPACES = /[\s\u0085\u2028\u2029]+/g;

/**
 * Makes a name, caption or path that other people (or the agent) chose safe to put in a prompt: control, direction and zero-width
 * characters are removed, line breaks and runs of spaces become one space, and anything past `max` characters is replaced by an ellipsis.
 */
export function sanitiseName(s: string, max = 80): string {
  const clean = s.replace(INVISIBLES, '').replace(CONTROLS, '').replace(SPACES, ' ').trim();
  const chars = Array.from(clean);
  return chars.length <= max ? clean : `${chars.slice(0, max).join('').trimEnd()}...`;
}

/** Who a prompt is about: the cleaned display name and the JID, with groups called groups. */
export function describeTarget(r: Resolved): string {
  const jid = sanitiseName(r.jid);
  const name = r.name ? sanitiseName(r.name) : '';
  return `${r.kind === 'group' ? 'group ' : ''}${name ? `${name} (${jid})` : jid}`;
}

export type ConfirmKind = 'text' | 'file' | 'react';

/**
 * What a confirmation is bound to: the kind of write, the chat and a digest of everything that changes what is sent. Each call works this out
 * for itself, and an answer counts only when the state that came back says the same.
 */
export interface ConfirmBinding {
  kind: ConfirmKind;
  jid: string;
  chatKind: ChatKind;
  /** SHA-256 hex over every field that changes what the send does. */
  digest: string;
}

/**
 * The payload of a prompt's signed state: the binding plus a nonce. It is signed but not encrypted, so it holds the chat and a digest of what
 * is sent, never the content. The nonce is minted with the prompt and lets the state be accepted once.
 */
export interface ConfirmState extends ConfirmBinding {
  /** 16 random bytes as hex. */
  nonce: string;
}

export interface TextSend { text: string; replyTo?: string; replyToSender?: string; mentions?: string[]; linkPreview?: boolean }
export interface FileSend { realPath: string; size: number; mtimeMs: number; caption?: string; as?: string; filename?: string }
export interface ReactSend { reaction: string; messageId: string; sender?: string }

type DigestField = string | number | boolean | string[] | null | undefined;

/** The same field set always digests the same way: keys are sorted, and a missing value is null. JSON keeps one field from running into the next. */
export function confirmDigest(kind: ConfirmKind, jid: string, chatKind: ChatKind, fields: Record<string, DigestField>): string {
  const pairs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, v ?? null]);
  return createHash('sha256').update(JSON.stringify([kind, jid, chatKind, pairs])).digest('hex');
}

const stateOf = (kind: ConfirmKind, to: Resolved, fields: Record<string, DigestField>): ConfirmBinding =>
  ({ kind, jid: to.jid, chatKind: to.kind, digest: confirmDigest(kind, to.jid, to.kind, fields) });

export const textState = (to: Resolved, s: TextSend): ConfirmBinding => stateOf('text', to, {
  text: s.text, reply_to: s.replyTo, reply_to_sender: s.replyToSender, mentions: s.mentions ?? [], link_preview: s.linkPreview !== false,
});

export const fileState = (to: Resolved, f: FileSend): ConfirmBinding => stateOf('file', to, {
  path: f.realPath, size: f.size, mtime: f.mtimeMs, caption: f.caption, as: f.as ?? 'auto', filename: f.filename,
});

export const reactState = (to: Resolved, r: ReactSend): ConfirmBinding => stateOf('react', to, {
  reaction: r.reaction, message_id: r.messageId, sender: r.sender,
});

const line = (label: string, value: string): string => `${label}: ${value}`;

/** The exact text goes in verbatim, because it is what will be sent; everything around it is cleaned. */
export function textPrompt(to: Resolved, s: TextSend): string {
  const options: string[] = [];
  if (s.replyTo) options.push(`Replying to message ${sanitiseName(s.replyTo)}${s.replyToSender ? ` from ${sanitiseName(s.replyToSender)}` : ''}`);
  else if (s.replyToSender) options.push(line('Quoted sender', sanitiseName(s.replyToSender)));
  if (s.mentions && s.mentions.length > 0) options.push(line('Mentioning', s.mentions.map((m) => sanitiseName(m)).join(', ')));
  if (s.linkPreview === false) options.push('Link preview: off');
  return [`Send to ${describeTarget(to)}?`, '', s.text, ...(options.length > 0 ? ['', ...options] : [])].join('\n');
}

export function filePrompt(to: Resolved, f: FileSend): string {
  const details: string[] = [];
  if (f.caption) details.push(line('Caption', sanitiseName(f.caption)));
  if (f.as && f.as !== 'auto') details.push(line('Sent as', sanitiseName(f.as)));
  if (f.filename) details.push(line('File name', sanitiseName(f.filename)));
  return [`Send file to ${describeTarget(to)}?`, '', `${sanitiseName(f.realPath, 1000)} (${f.size} bytes)`, ...details].join('\n');
}

export function reactPrompt(to: Resolved, r: ReactSend): string {
  const reaction = sanitiseName(r.reaction);
  const head = reaction === '' ? 'Clear your reaction' : `React with ${reaction}`;
  return `${head} to message ${sanitiseName(r.messageId)} in ${describeTarget(to)}?${r.sender ? `\n\n${line('Original sender', sanitiseName(r.sender))}` : ''}`;
}

/** How long a prompt's state stays good, in seconds. The nonce of an accepted state is remembered for as long. */
const STATE_TTL_SECONDS = 300;

let codec: RequestStateCodec<ConfirmState> | undefined;

/**
 * The one codec for this process. Its key is random and never leaves memory, so a state from another process or an earlier run does not
 * verify, and a state stops verifying five minutes after it was minted.
 */
export function confirmCodec(): RequestStateCodec<ConfirmState> {
  codec ??= createRequestStateCodec<ConfirmState>({ key: randomBytes(32), ttlSeconds: STATE_TTL_SECONDS });
  return codec;
}

/**
 * Nonces of states that have been accepted, each with the time (ms) after which it can be forgotten. A state is only good for five minutes
 * and the nonce is kept for five minutes from its acceptance, so by the time it is forgotten the SDK refuses the state anyway.
 */
const consumed = new Map<string, number>();

/** How many accepted nonces are being remembered. For tests. */
export function consumedNonceCount(): number {
  return consumed.size;
}

const sameBinding = (actual: unknown, expected: ConfirmBinding): actual is Record<string, unknown> => {
  if (typeof actual !== 'object' || actual === null) return false;
  const s = actual as Record<string, unknown>;
  return s.kind === expected.kind && s.jid === expected.jid && s.chatKind === expected.chatKind && s.digest === expected.digest;
};

/**
 * The person's answer to the prompt for exactly this send. An accept counts only when the state that came back with it (already proven
 * genuine and unexpired by the SDK before the handler ran) matches the send being made now and has not been accepted before; otherwise the
 * person is asked again. Anything that is not an accept with the box ticked stays declined. Accepting uses the state's nonce up.
 */
export function readAnswer(ctx: HandlerCtx, expected: ConfirmBinding): Answer {
  const now = Date.now();
  for (const [nonce, until] of consumed) if (until < now) consumed.delete(nonce);
  const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
  if (view.kind === 'missing') return 'none';
  const accepted = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
  if (accepted?.confirm !== true) return 'declined';
  const state = ctx.mcpReq.requestState<unknown>();
  if (!sameBinding(state, expected)) return 'none';
  const nonce = state.nonce;
  if (typeof nonce !== 'string' || nonce === '' || consumed.has(nonce)) return 'none';
  consumed.set(nonce, now + STATE_TTL_SECONDS * 1000);
  return 'accepted';
}

/** The prompt, with a state minted for it: the binding plus a nonce that belongs to this prompt alone. */
export async function confirmationRequired(message: string, binding: ConfirmBinding): Promise<InputRequiredResult> {
  const state: ConfirmState = { ...binding, nonce: randomBytes(16).toString('hex') };
  return inputRequired({
    inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: ConfirmSchema }) },
    requestState: await confirmCodec().mint(state),
  });
}
