export type ChatKind = 'user' | 'group' | 'channel' | 'broadcast' | 'unknown';

export interface AgentChat {
  jid: string; name: string | null; kind: ChatKind; last_message_at: string | null;
  unread_count: number; archived: boolean; pinned: boolean; muted: boolean;
}
export interface AgentMedia { type: string; caption: string | null; filename: string | null; mime: string | null }
export interface AgentMessage {
  id: string; chat_jid: string; sender_jid: string | null; sender_name: string | null; from_me: boolean;
  timestamp: string | null; text: string | null; media: AgentMedia | null;
  reply_to: { id: string; sender_jid: string | null } | null; edited: boolean; revoked: boolean;
}
export interface AgentContact { jid: string; phone: string | null; name: string | null; alias: string | null; system_name: string | null }
export interface AgentGroup {
  jid: string; name: string | null; owner_jid: string | null; is_community: boolean;
  linked_parent_jid: string | null; created_at: string | null;
}
export interface AgentParticipant { jid: string; role: string; is_admin: boolean }

// Raw wacli rows. Message and group rows use Go field names (no JSON tags in wacli).
export interface WacliChat {
  jid: string; kind?: string; name?: string; last_message_ts?: string; archived?: boolean;
  pinned?: boolean; muted_until?: number; unread?: boolean; unread_count?: number;
}
export interface WacliMessage {
  ChatJID: string; ChatName?: string; MsgID: string; SenderJID?: string; SenderName?: string; Timestamp?: string;
  FromMe?: boolean; Text?: string; DisplayText?: string; quoted_msg_id?: string; quoted_sender_jid?: string;
  MediaType?: string; MediaCaption?: string; Filename?: string; MimeType?: string; Edited?: boolean; Revoked?: boolean;
  Snippet?: string;
}
export interface WacliContact { jid: string; phone?: string; name?: string; alias?: string; system_name?: string }
export interface WacliGroup { JID: string; Name?: string; OwnerJID?: string; IsParent?: boolean; LinkedParentJID?: string; CreatedAt?: string }
export interface WacliParticipant { group_jid: string; user_jid: string; role?: string }
export interface WacliPage { has_more: boolean; next_cursor: string | null }
export interface WacliMessagePage {
  messages: WacliMessage[]; fts?: boolean; page?: WacliPage; source?: { last_sync_at: string | null; scope: string };
}
export interface WacliContext { chat_jid: string; msg_id: string; messages: WacliMessage[] }
export interface WacliResolution { input: string; jid?: string; phone?: string; lid?: string; name?: string; resolved: boolean; error?: string }
export interface WacliDoctor {
  store_dir: string; lock_held: boolean; authenticated: boolean; session_revoked: boolean; linked_jid?: string;
  connected: boolean; connection_state: string; fts_enabled: boolean;
  store?: { messages?: number; chats?: number; contacts?: number; groups?: number; last_sync_at?: string; last_activity_at?: string };
  store_error?: string;
}
export interface WacliAuthStatus { authenticated: boolean; linked_jid?: string; phone?: string }
export interface WacliSendResult { sent: boolean; to: string; id: string; store_warning?: string }
export interface WacliMediaDownload {
  chat: string; id: string; path: string; bytes: number; media_type: string; mime_type: string; downloaded: boolean; source: string;
}
export interface WacliChatStateResult { ok: boolean; action: string; chat: string }

export function nonEmpty(s: string | undefined | null): string | null {
  return s !== undefined && s !== null && s.trim() !== '' ? s : null;
}

export function toIso(s: string | undefined | null): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 1971) return null;
  return d.toISOString();
}

export function kindFromJid(jid: string): ChatKind {
  if (jid.endsWith('@g.us')) return 'group';
  if (jid.endsWith('@newsletter')) return 'channel';
  if (jid.endsWith('@broadcast')) return 'broadcast';
  if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return 'user';
  return 'unknown';
}

export function kindFromWacli(kind: string | undefined, jid: string): ChatKind {
  switch (kind) {
    case 'dm': return 'user';
    case 'group': return 'group';
    case 'newsletter': return 'channel';
    case 'broadcast': return 'broadcast';
    default: return kindFromJid(jid);
  }
}

export function toChat(raw: WacliChat, now: Date = new Date()): AgentChat {
  const mutedUntil = raw.muted_until ?? 0;
  return {
    jid: raw.jid,
    name: nonEmpty(raw.name),
    kind: kindFromWacli(raw.kind, raw.jid),
    last_message_at: toIso(raw.last_message_ts),
    unread_count: raw.unread_count ?? 0,
    archived: Boolean(raw.archived),
    pinned: Boolean(raw.pinned),
    muted: mutedUntil === -1 || mutedUntil * 1000 > now.getTime(),
  };
}

/** A message row needs both ids to be a message at all. wacli's rows are untyped JSON, so a row without them is dropped rather than failing the page. */
export function hasMessageIds(row: unknown): row is WacliMessage {
  if (typeof row !== 'object' || row === null) return false;
  const r = row as { MsgID?: unknown; ChatJID?: unknown };
  return typeof r.MsgID === 'string' && typeof r.ChatJID === 'string';
}

export function toMessage(raw: WacliMessage): AgentMessage {
  const type = nonEmpty(raw.MediaType);
  const revoked = Boolean(raw.Revoked);
  return {
    id: raw.MsgID,
    chat_jid: raw.ChatJID,
    sender_jid: nonEmpty(raw.SenderJID),
    sender_name: nonEmpty(raw.SenderName),
    from_me: Boolean(raw.FromMe),
    timestamp: toIso(raw.Timestamp),
    // A revoked message was withdrawn by its sender; wacli may still hold the content, but the agent must not see it.
    text: revoked ? null : (nonEmpty(raw.Text) ?? nonEmpty(raw.DisplayText)),
    media: type && !revoked ? { type, caption: nonEmpty(raw.MediaCaption), filename: nonEmpty(raw.Filename), mime: nonEmpty(raw.MimeType) } : null,
    reply_to: raw.quoted_msg_id ? { id: raw.quoted_msg_id, sender_jid: nonEmpty(raw.quoted_sender_jid) } : null,
    edited: Boolean(raw.Edited),
    revoked,
  };
}

export function toContact(raw: WacliContact): AgentContact {
  return { jid: raw.jid, phone: nonEmpty(raw.phone), name: nonEmpty(raw.name), alias: nonEmpty(raw.alias), system_name: nonEmpty(raw.system_name) };
}

export function toGroup(raw: WacliGroup): AgentGroup {
  return {
    jid: raw.JID,
    name: nonEmpty(raw.Name),
    owner_jid: nonEmpty(raw.OwnerJID),
    is_community: Boolean(raw.IsParent),
    linked_parent_jid: nonEmpty(raw.LinkedParentJID),
    created_at: toIso(raw.CreatedAt),
  };
}

export function toParticipant(raw: WacliParticipant): AgentParticipant {
  const role = nonEmpty(raw.role) ?? 'member';
  return { jid: raw.user_jid, role, is_admin: role === 'admin' || role === 'superadmin' };
}

export function phoneFromJid(jid: string | undefined | null): string | null {
  if (!jid || !jid.endsWith('@s.whatsapp.net')) return null;
  const digits = (jid.split('@')[0] ?? '').split(':')[0] ?? '';
  return /^\d{6,}$/.test(digits) ? `+${digits}` : null;
}

/** wacli (Go) encodes an empty list as null; treat anything that is not an array as empty. */
export function asList<T>(v: T[] | null | undefined): T[] {
  return Array.isArray(v) ? v : [];
}
