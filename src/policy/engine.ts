import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { Resolved } from '../wacli/resolve.js';
import { canonicalJid, digitsOf, JID_RE, looksLikePhone } from '../wacli/resolve.js';
import type { Policy } from './schema.js';

export type WriteTool = 'send_text' | 'send_file' | 'react' | 'mark_read';
export interface RateSnapshot { countLastHour: number; secondsSinceLast: number | null; secondsUntilWindowFrees: number }
export type Answer = 'none' | 'accepted' | 'declined';

export interface DecideInput {
  policy: Policy;
  tool: WriteTool;
  recipient: Resolved;
  fileInsideRoots?: boolean;
  rate: RateSnapshot;
  clientCanConfirm: boolean;
  answer: Answer;
}

export type DenyCode =
  | 'writes_disabled' | 'unsupported_target' | 'groups_disabled' | 'file_outside_roots'
  | 'rate_limited' | 'confirmation_unavailable' | 'confirmation_declined';

export type Decision =
  | { kind: 'allow' }
  | { kind: 'confirm' }
  | { kind: 'deny'; code: DenyCode; message: string; retryAfterSeconds?: number };

export const DENY_MESSAGES: Record<DenyCode, string> = {
  writes_disabled: 'Sending is turned off in the policy. The person can enable it with: whatsapp-agent policy enable',
  unsupported_target: 'Only people and groups can receive messages. Channels, broadcast lists and unknown chat types are read-only in this version.',
  groups_disabled: 'Sending to groups is turned off. The person can enable it with: whatsapp-agent policy set groups on',
  file_outside_roots: 'That file is outside the allowed folders. The person can add a folder with: whatsapp-agent policy add-file-root <dir>',
  rate_limited: 'Send rate limit reached. Wait before sending again.',
  confirmation_unavailable: 'This send needs the person to confirm, but this client cannot show a confirmation form. The person can allowlist the recipient with: whatsapp-agent policy allow <recipient>, and set: whatsapp-agent policy set confirm unlisted',
  confirmation_declined: 'The person declined. Nothing was sent.',
};

export function jidUser(jid: string): string {
  return (jid.split('@')[0] ?? '').split(':')[0] ?? '';
}

/** Entries are phone numbers (compared by digits) or JIDs. Names never match: display names are chosen by other people. */
export function matchesAllow(allow: string[], r: Resolved): boolean {
  const jid = canonicalJid(r.jid).toLowerCase();
  const user = jidUser(jid);
  for (const raw of allow) {
    const e = raw.trim().toLowerCase();
    if (e === '') continue;
    if (JID_RE.test(e) && canonicalJid(e) === jid) return true;
    if (looksLikePhone(e) && digitsOf(e) === user) return true;
  }
  return false;
}

/** True when two allowlist entries denote the same recipient: phones by digits, user JIDs by their number, other JIDs canonical, else exact text, all case-insensitive. */
export function sameAllowTarget(a: string, b: string): boolean {
  const key = (raw: string): string => {
    const s = raw.trim();
    const l = s.toLowerCase();
    if (JID_RE.test(l)) {
      const c = canonicalJid(l);
      return c.endsWith('@s.whatsapp.net') ? `user:${jidUser(c)}` : `jid:${c}`;
    }
    if (looksLikePhone(s)) return `user:${digitsOf(s)}`;
    return `text:${l}`;
  };
  return key(a) === key(b);
}

function deny(code: DenyCode, retryAfterSeconds?: number): Decision {
  const message = retryAfterSeconds === undefined
    ? DENY_MESSAGES[code]
    : `${DENY_MESSAGES[code]} Retry after ${retryAfterSeconds} seconds.`;
  return retryAfterSeconds === undefined ? { kind: 'deny', code, message } : { kind: 'deny', code, message, retryAfterSeconds };
}

export function decide(i: DecideInput): Decision {
  const w = i.policy.writes;
  if (!w.enabled) return deny('writes_disabled');
  if (i.tool === 'mark_read') return { kind: 'allow' };
  if (i.recipient.kind !== 'user' && i.recipient.kind !== 'group') return deny('unsupported_target');
  if (i.recipient.kind === 'group' && !w.groups) return deny('groups_disabled');
  if (i.tool === 'send_file' && i.fileInsideRoots !== true) return deny('file_outside_roots');

  if (i.rate.countLastHour >= w.rateLimit.perHour) return deny('rate_limited', Math.max(1, Math.ceil(i.rate.secondsUntilWindowFrees)));
  if (i.rate.secondsSinceLast !== null && i.rate.secondsSinceLast < w.rateLimit.minGapSeconds) {
    return deny('rate_limited', Math.max(1, Math.ceil(w.rateLimit.minGapSeconds - i.rate.secondsSinceLast)));
  }

  const needsConfirmation = w.confirm === 'always' || (w.confirm === 'unlisted' && !matchesAllow(w.allow, i.recipient));
  if (!needsConfirmation) return { kind: 'allow' };
  if (!i.clientCanConfirm) return deny('confirmation_unavailable');
  if (i.answer === 'none') return { kind: 'confirm' };
  if (i.answer === 'declined') return deny('confirmation_declined');
  return { kind: 'allow' };
}

export function isInsideRoot(realPath: string, realRoot: string): boolean {
  const rel = path.relative(realRoot, realPath);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function fileInsideRoots(filePath: string, roots: string[]): Promise<boolean> {
  let real: string;
  try {
    real = await realpath(filePath);
  } catch {
    return false;
  }
  for (const root of roots) {
    try {
      const realRoot = await realpath(root);
      if (isInsideRoot(real, realRoot)) return true;
    } catch {
      // missing root: skip
    }
  }
  return false;
}
