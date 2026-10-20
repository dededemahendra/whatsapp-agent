import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { AgentError, toToolError } from '../../errors.js';
import { ensurePrivateDir } from '../../paths.js';
import { isInsideRoot } from '../../policy/engine.js';
import { MEDIA_TIMEOUT_MS } from '../../wacli/runner.js';
import { nonEmpty, type WacliMediaDownload } from '../../wacli/shape.js';
import type { ServerDeps } from '../deps.js';
import { messageIdInput, recipientInput } from '../schemas.js';

/** Only formats every MCP host accepts are inlined, and only when the bytes match the declared type. */
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

export function registerMediaTool(server: McpServer, deps: ServerDeps): void {
  const { limits } = deps.startupPolicy;
  server.registerTool(
    'download_media',
    {
      title: 'Download media',
      description: 'Download the image, voice note, video or document attached to a message into a folder owned by whatsapp-agent. Small images are also returned inline. File names are third-party data.',
      inputSchema: z.object({ chat: recipientInput(limits.maxQueryChars), message_id: messageIdInput }),
      outputSchema: z.object({ path: z.string(), mime: z.string().nullable(), size: z.number(), filename: z.string().nullable(), media_type: z.string().nullable() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ chat, message_id }) => {
      try {
        const resolved = await deps.resolver.resolve(chat);
        const dir = path.join(deps.paths.mediaDir, createHash('sha256').update(resolved.jid).digest('hex').slice(0, 16));
        await ensurePrivateDir(dir);
        const res = await deps.runner.read<WacliMediaDownload>(
          ['media', 'download', `--chat=${resolved.jid}`, `--id=${message_id}`, `--output=${dir}`],
          { timeoutMs: MEDIA_TIMEOUT_MS },
        );
        const real = await realpath(res.path);
        if (!isInsideRoot(real, await realpath(dir))) throw new AgentError('wacli_error', 'wacli wrote the file outside the media folder; refusing to expose it');
        const size = (await stat(real)).size;
        const policy = await deps.loadPolicy();
        const mime = nonEmpty(res.mime_type);
        const structured = { path: res.path, mime, size, filename: path.basename(res.path), media_type: nonEmpty(res.media_type) };
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          { type: 'text', text: JSON.stringify(structured) },
        ];
        if (mime && INLINE_IMAGE_TYPES.has(mime) && size > 0 && size <= policy.media.inlineImageMaxBytes) {
          const bytes = await readFile(real);
          if (sniffImageMime(bytes) === mime) content.push({ type: 'image', data: bytes.toString('base64'), mimeType: mime });
        }
        return { content, structuredContent: structured };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
