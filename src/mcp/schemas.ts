import * as z from 'zod/v4';

export const ChatKindSchema = z.enum(['user', 'group', 'channel', 'broadcast', 'unknown']);
export const ResolvedSchema = z.object({ jid: z.string(), name: z.string().nullable(), kind: ChatKindSchema });

export const ChatSchema = z.object({
  jid: z.string(), name: z.string().nullable(), kind: ChatKindSchema, last_message_at: z.string().nullable(),
  unread_count: z.number(), archived: z.boolean(), pinned: z.boolean(), muted: z.boolean(),
});

export const MessageSchema = z.object({
  id: z.string(), chat_jid: z.string(), sender_jid: z.string().nullable(), sender_name: z.string().nullable(),
  from_me: z.boolean(), timestamp: z.string().nullable(), text: z.string().nullable(),
  media: z.object({ type: z.string(), caption: z.string().nullable(), filename: z.string().nullable(), mime: z.string().nullable() }).nullable(),
  reply_to: z.object({ id: z.string(), sender_jid: z.string().nullable() }).nullable(),
  edited: z.boolean(), revoked: z.boolean(),
});

export const PageSchema = z.object({ has_more: z.boolean(), next_cursor: z.string().nullable() });

export const ContactSchema = z.object({
  jid: z.string(), phone: z.string().nullable(), name: z.string().nullable(), alias: z.string().nullable(), system_name: z.string().nullable(),
});

export const GroupSchema = z.object({
  jid: z.string(), name: z.string().nullable(), owner_jid: z.string().nullable(), is_community: z.boolean(),
  linked_parent_jid: z.string().nullable(), created_at: z.string().nullable(),
});

export const ParticipantSchema = z.object({ jid: z.string(), role: z.string(), is_admin: z.boolean() });

export const SendResultSchema = z.object({ sent: z.literal(true), message_id: z.string(), to: ResolvedSchema, timestamp: z.string() });

export const dateInput = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}(T[0-9:.+\-Z]*)?$/, 'Use YYYY-MM-DD or RFC 3339');
export const messageIdInput = z.string().min(1).max(200).regex(/^[\w\-:.@=]+$/, 'Message id contains unexpected characters');
export const limitInput = z.int().min(1).max(200);
export const recipientInput = (max: number) => z.string().min(1).max(max).describe('Phone number, JID, or exact chat or contact name');
