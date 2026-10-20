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
        if (mime && mime.startsWith('image/') && size <= policy.media.inlineImageMaxBytes) {
          content.push({ type: 'image', data: (await readFile(real)).toString('base64'), mimeType: mime });
        }
        return { content, structuredContent: structured };
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
