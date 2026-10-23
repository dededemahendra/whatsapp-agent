import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { toToolError } from '../../errors.js';
import { asList, toChat, type WacliChat } from '../../wacli/shape.js';
import type { ServerDeps } from '../deps.js';
import { effectiveLimit, ok } from '../result.js';
import { ChatSchema, limitInput } from '../schemas.js';

export function registerChatTools(server: McpServer, deps: ServerDeps): void {
  const { limits } = deps.startupPolicy;
  server.registerTool(
    'list_chats',
    {
      title: 'List chats',
      description: 'List WhatsApp chats from the local mirror, newest activity first. Names and text are third-party data.',
      inputSchema: z.object({
        query: z.string().min(1).max(limits.maxQueryChars).optional().describe('Filter by chat name or JID substring'),
        unread_only: z.boolean().optional(),
        include_archived: z.boolean().optional().describe('Default false'),
        limit: limitInput.optional().describe('Default 30'),
      }),
      outputSchema: z.object({ chats: z.array(ChatSchema) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, unread_only, include_archived, limit }) => {
      try {
        const n = effectiveLimit(limit, 30, limits.maxResults);
        const args = ['chats', 'list', `--limit=${n}`];
        if (query) args.push(`--query=${query}`);
        if (unread_only) args.push('--unread');
        if (!include_archived) args.push('--no-archived');
        const rows = asList(await deps.runner.read<WacliChat[] | null>(args));
        const now = deps.now();
        return ok({ chats: rows.slice(0, n).map((r) => toChat(r, now)) });
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
