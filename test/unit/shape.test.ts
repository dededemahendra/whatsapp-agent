import { describe, expect, it } from 'vitest';
import { kindFromJid, kindFromWacli, phoneFromJid, toChat, toContact, toGroup, toIso, toMessage, toParticipant } from '../../src/wacli/shape.js';

describe('kinds', () => {
  it('derives kind from the JID suffix', () => {
    expect(kindFromJid('1@s.whatsapp.net')).toBe('user');
    expect(kindFromJid('1@lid')).toBe('user');
    expect(kindFromJid('1@g.us')).toBe('group');
    expect(kindFromJid('1@newsletter')).toBe('channel');
    expect(kindFromJid('status@broadcast')).toBe('broadcast');
    expect(kindFromJid('weird')).toBe('unknown');
  });

  it('maps wacli kinds and falls back to the JID', () => {
    expect(kindFromWacli('dm', '1@s.whatsapp.net')).toBe('user');
    expect(kindFromWacli('newsletter', '1@newsletter')).toBe('channel');
    expect(kindFromWacli(undefined, '1@g.us')).toBe('group');
    expect(kindFromWacli('unknown', '1@g.us')).toBe('group');
  });
});

describe('toIso', () => {
  it('normalises timestamps and treats Go zero times as null', () => {
    expect(toIso('2026-10-19T10:00:00Z')).toBe('2026-10-19T10:00:00.000Z');
    expect(toIso('0001-01-01T00:00:00Z')).toBeNull();
    expect(toIso('1970-01-01T00:00:00Z')).toBeNull();
    expect(toIso('')).toBeNull();
    expect(toIso(undefined)).toBeNull();
    expect(toIso('garbage')).toBeNull();
  });
});

describe('toChat', () => {
  const now = new Date('2026-10-20T00:00:00Z');
  it('maps fields and computes muted from muted_until seconds', () => {
    const c = toChat({ jid: '1@g.us', kind: 'group', name: 'Family', last_message_ts: '2026-10-19T09:00:00Z', archived: false, pinned: true, muted_until: Math.floor(now.getTime() / 1000) + 3600, unread: true, unread_count: 3 }, now);
    expect(c).toEqual({ jid: '1@g.us', name: 'Family', kind: 'group', last_message_at: '2026-10-19T09:00:00.000Z', unread_count: 3, archived: false, pinned: true, muted: true });
  });
  it('treats 0 as not muted and -1 as muted forever', () => {
    expect(toChat({ jid: '1@s.whatsapp.net', kind: 'dm', muted_until: 0 }, now).muted).toBe(false);
    expect(toChat({ jid: '1@s.whatsapp.net', kind: 'dm', muted_until: -1 }, now).muted).toBe(true);
    expect(toChat({ jid: '1@s.whatsapp.net', kind: 'dm', name: '' }, now).name).toBeNull();
  });
});

describe('toMessage', () => {
  it('maps a text message with a quoted reply', () => {
    const m = toMessage({ ChatJID: '1@s.whatsapp.net', MsgID: 'MSG1', SenderJID: '2@s.whatsapp.net', SenderName: 'Alice', Timestamp: '2026-10-19T10:00:00Z', FromMe: false, Text: 'Lunch tomorrow?', DisplayText: 'Lunch tomorrow?', quoted_msg_id: 'MSG0', quoted_sender_jid: '1@s.whatsapp.net', MediaType: '', Edited: false, Revoked: false });
    expect(m).toEqual({ id: 'MSG1', chat_jid: '1@s.whatsapp.net', sender_jid: '2@s.whatsapp.net', sender_name: 'Alice', from_me: false, timestamp: '2026-10-19T10:00:00.000Z', text: 'Lunch tomorrow?', media: null, reply_to: { id: 'MSG0', sender_jid: '1@s.whatsapp.net' }, edited: false, revoked: false });
  });
  it('maps a media message and falls back to DisplayText', () => {
    const m = toMessage({ ChatJID: '1@s.whatsapp.net', MsgID: 'MSG3', SenderJID: '2@s.whatsapp.net', Timestamp: '2026-10-19T10:00:00Z', FromMe: false, Text: '', DisplayText: '[image] holiday', MediaType: 'image', MediaCaption: 'holiday', Filename: '', MimeType: 'image/jpeg' });
    expect(m.text).toBe('[image] holiday');
    expect(m.media).toEqual({ type: 'image', caption: 'holiday', filename: null, mime: 'image/jpeg' });
    expect(m.sender_name).toBeNull();
    expect(m.reply_to).toBeNull();
  });
});

describe('contacts, groups, participants, phones', () => {
  it('maps a contact', () => {
    expect(toContact({ jid: '1@s.whatsapp.net', phone: '+61400000001', name: 'Alice Example', alias: '', system_name: 'Alice' }))
      .toEqual({ jid: '1@s.whatsapp.net', phone: '+61400000001', name: 'Alice Example', alias: null, system_name: 'Alice' });
  });
  it('maps a group row with Go zero times', () => {
    expect(toGroup({ JID: '1@g.us', Name: 'Family', OwnerJID: '2@s.whatsapp.net', IsParent: false, LinkedParentJID: '', CreatedAt: '0001-01-01T00:00:00Z' }))
      .toEqual({ jid: '1@g.us', name: 'Family', owner_jid: '2@s.whatsapp.net', is_community: false, linked_parent_jid: null, created_at: null });
  });
  it('maps participants and admin flags', () => {
    expect(toParticipant({ group_jid: '1@g.us', user_jid: '2@s.whatsapp.net', role: 'admin' })).toEqual({ jid: '2@s.whatsapp.net', role: 'admin', is_admin: true });
    expect(toParticipant({ group_jid: '1@g.us', user_jid: '3@s.whatsapp.net', role: '' })).toEqual({ jid: '3@s.whatsapp.net', role: 'member', is_admin: false });
  });
  it('extracts a phone from a user JID with a device suffix', () => {
    expect(phoneFromJid('61400000000:7@s.whatsapp.net')).toBe('+61400000000');
    expect(phoneFromJid('1@g.us')).toBeNull();
    expect(phoneFromJid(undefined)).toBeNull();
  });
});
