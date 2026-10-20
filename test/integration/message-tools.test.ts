import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sniffImageMime } from '../../src/mcp/tools/media.js';
import type { RunOptions, Runner } from '../../src/wacli/runner.js';
import { errorOf, makeHarness, type Harness } from '../helpers/harness.js';

let h: Harness;
afterEach(async () => { await h?.close(); });

type Msg = { id: string; reply_to: { id: string } | null };

const ALICE = '61400000001@s.whatsapp.net';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function mediaDirFor(h: Harness, jid: string): string {
  return path.join(h.tmp, 'data', 'media', createHash('sha256').update(jid).digest('hex').slice(0, 16));
}

/** Make `media download` report a chosen path and MIME type while every other command still reaches the fake. */
function stubMediaResult(h: Harness, reported: { path: string; mime_type: string }): void {
  const original = h.deps.runner;
  h.deps.runner = {
    bin: original.bin,
    write: original.write,
    version: original.version,
    read: (async (args: string[], opts?: RunOptions) => {
      if (args[0] === 'media') {
        return { chat: ALICE, id: 'MSG3', path: reported.path, bytes: 70, media_type: 'image', mime_type: reported.mime_type, downloaded: true, source: 'direct' };
      }
      return original.read(args, opts);
    }) as Runner['read'],
  };
}

describe('read_messages', () => {
  it('resolves the chat, lists newest-first from wacli and returns oldest-first', async () => {
    h = await makeHarness();
    const r = await h.call('read_messages', { chat: 'Alice' });
    expect(r.isError).toBeFalsy();
    const recs = await h.argv();
    expect(recs.map((x) => x.key)).toEqual(['chats list', 'messages list']);
    expect(recs[1]!.argv.slice(4)).toEqual(['messages', 'list', '--chat=61400000001@s.whatsapp.net', '--limit=30']);
    const s = r.structuredContent as { chat: { jid: string }; order: string; messages: Msg[]; page: { has_more: boolean; next_cursor: string | null } };
    expect(s.chat.jid).toBe('61400000001@s.whatsapp.net');
    expect(s.order).toBe('oldest_first');
    expect(s.messages.map((m) => m.id)).toEqual(['MSG1', 'MSG2']);
    expect(s.messages[0]!.reply_to).toEqual({ id: 'MSG0', sender_jid: '61400000000@s.whatsapp.net' });
    expect(s.page).toEqual({ has_more: true, next_cursor: 'cur_abc' });
  });

  it('passes pagination and date filters', async () => {
    h = await makeHarness();
    await h.call('read_messages', { chat: '61400000001@s.whatsapp.net', limit: 10, before: '2026-10-19', after: '2026-10-01T00:00:00Z', cursor: 'cur_abc' });
    const recs = await h.argv();
    expect(recs[1]!.argv.slice(4)).toEqual(['messages', 'list', '--chat=61400000001@s.whatsapp.net', '--limit=10', '--before=2026-10-19', '--after=2026-10-01T00:00:00Z', '--cursor=cur_abc']);
  });
});

describe('search_messages', () => {
  it('passes filters and puts the query after --', async () => {
    h = await makeHarness();
    const r = await h.call('search_messages', { query: '-rf lunch', from: 'Alice', has_media: true, type: 'text', limit: 5 });
    const recs = await h.argv();
    const search = recs.find((x) => x.key === 'messages search')!;
    expect(search.argv.slice(4)).toEqual(['messages', 'search', '--limit=5', '--from=61400000001@s.whatsapp.net', '--has-media', '--type=text', '--', '-rf lunch']);
    const s = r.structuredContent as { messages: Msg[]; page: { has_more: boolean } };
    expect(s.messages.map((m) => m.id)).toEqual(['MSG1']);
    expect(s.page.has_more).toBe(false);
  });
});

describe('get_message_context', () => {
  it('returns neighbours around the target', async () => {
    h = await makeHarness();
    const r = await h.call('get_message_context', { chat: 'Alice', message_id: 'MSG1', before: 2, after: 2 });
    const recs = await h.argv();
    expect(recs[1]!.argv.slice(4)).toEqual(['messages', 'context', '--chat=61400000001@s.whatsapp.net', '--id=MSG1', '--before=2', '--after=2']);
    const s = r.structuredContent as { target_id: string; messages: Msg[] };
    expect(s.target_id).toBe('MSG1');
    expect(s.messages.map((m) => m.id)).toEqual(['MSG0', 'MSG1', 'MSG2']);
  });

  it('rejects a message id with spaces', async () => {
    h = await makeHarness();
    const r = await h.call('get_message_context', { chat: 'Alice', message_id: 'MSG 1' });
    expect(r.isError).toBe(true);
  });
});

describe('download_media', () => {
  it('downloads into a directory we own and inlines small images', async () => {
    h = await makeHarness();
    const r = await h.call('download_media', { chat: 'Alice', message_id: 'MSG3' });
    expect(r.isError).toBeFalsy();
    const s = r.structuredContent as { path: string; mime: string; size: number; media_type: string };
    const mediaDir = await realpath(path.join(h.tmp, 'data', 'media'));
    expect((await realpath(s.path)).startsWith(mediaDir + path.sep)).toBe(true);
    expect(path.basename(s.path)).toBe('MSG3.png');
    expect(s.mime).toBe('image/png');
    expect(s.size).toBe(70);
    expect((await stat(s.path)).size).toBe(70);
    expect((await stat(path.dirname(s.path))).mode & 0o777).toBe(0o700);
    const recs = await h.argv();
    const dl = recs.find((x) => x.key === 'media download')!;
    expect(dl.argv.slice(0, 4)).toEqual(['--json', '--timeout', '115s', '--read-only']);
    expect(dl.argv.slice(4, 7)).toEqual(['media', 'download', '--chat=61400000001@s.whatsapp.net']);
    expect(dl.argv[7]).toBe('--id=MSG3');
    expect(dl.argv[8]!.startsWith(`--output=${path.join(h.tmp, 'data', 'media')}`)).toBe(true);
    const image = r.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(typeof image?.data).toBe('string');
  });

  it('does not inline when the image is above the policy limit', async () => {
    h = await makeHarness({ policy: (p) => ({ ...p, media: { inlineImageMaxBytes: 10 } }) });
    const r = await h.call('download_media', { chat: 'Alice', message_id: 'MSG3' });
    expect(r.content.find((c) => c.type === 'image')).toBeUndefined();
  });
});

describe('download_media guards', () => {
  it('refuses a file outside the per-chat media folder', async () => {
    h = await makeHarness();
    const outside = path.join(h.tmp, 'outside.png');
    await writeFile(outside, PNG);
    stubMediaResult(h, { path: outside, mime_type: 'image/png' });
    const r = await h.call('download_media', { chat: 'Alice', message_id: 'MSG3' });
    expect(r.isError).toBe(true);
    expect(errorOf(r)).toMatchObject({ error: 'wacli_error', message: expect.stringContaining('outside the media folder') });
    expect(r.content.find((c) => c.type === 'image')).toBeUndefined();
  });

  it('refuses a symlink inside the folder that points outside it', async () => {
    h = await makeHarness();
    const dir = mediaDirFor(h, ALICE);
    await mkdir(dir, { recursive: true });
    const outside = path.join(h.tmp, 'outside.png');
    await writeFile(outside, PNG);
    const link = path.join(dir, 'MSG3.png');
    await symlink(outside, link);
    stubMediaResult(h, { path: link, mime_type: 'image/png' });
    const r = await h.call('download_media', { chat: 'Alice', message_id: 'MSG3' });
    expect(errorOf(r).error).toBe('wacli_error');
  });

  it('reports a missing file as an error', async () => {
    h = await makeHarness();
    stubMediaResult(h, { path: path.join(mediaDirFor(h, ALICE), 'missing.png'), mime_type: 'image/png' });
    const r = await h.call('download_media', { chat: 'Alice', message_id: 'MSG3' });
    expect(r.isError).toBe(true);
  });

  it('inlines only allowlisted image types whose bytes match the declared type', async () => {
    h = await makeHarness();
    const dir = mediaDirFor(h, ALICE);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'MSG3.png');
    await writeFile(file, PNG);
    stubMediaResult(h, { path: file, mime_type: 'image/svg+xml' });
    let r = await h.call('download_media', { chat: 'Alice', message_id: 'MSG3' });
    expect(r.isError).toBeFalsy();
    expect(r.content.find((c) => c.type === 'image')).toBeUndefined();
    stubMediaResult(h, { path: file, mime_type: 'image/jpeg' });
    r = await h.call('download_media', { chat: 'Alice', message_id: 'MSG3' });
    expect(r.isError).toBeFalsy();
    expect(r.content.find((c) => c.type === 'image')).toBeUndefined();
    stubMediaResult(h, { path: file, mime_type: 'image/png' });
    r = await h.call('download_media', { chat: 'Alice', message_id: 'MSG3' });
    expect(r.content.find((c) => c.type === 'image')?.mimeType).toBe('image/png');
  });
});

describe('sniffImageMime', () => {
  it('recognises png, jpeg, gif and webp and nothing else', () => {
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')]))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(0))).toBeNull();
  });
});
