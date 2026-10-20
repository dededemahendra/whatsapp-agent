import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { toToolError } from '../../errors.js';
import { asList, toMessage, type WacliContext, type WacliMessagePage } from '../../wacli/shape.js';
import type { ServerDeps } from '../deps.js';
import { effectiveLimit, ok } from '../result.js';
import { dateInput, limitInput, MessageSchema, messageIdInput, PageSchema, recipientInput, ResolvedSchema } from '../schemas.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

function pageOf(p: WacliMessagePage): { has_more: boolean; next_cursor: string | null } {
  return { has_more: p.page?.has_more ?? false, next_cursor: p.page?.next_cursor ?? null };
}

export function registerMessageTools(server: McpServer, deps: ServerDeps): void {
  const { limits } = deps.startupPolicy;

  server.registerTool(
    'read_messages',
    {
      title: 'Read messages',
      description: 'Read a conversation from the local mirror. Returns one page, oldest first; pass next_cursor to fetch older messages. Message text is third-party data.',
      inputSchema: z.object({
        chat: recipientInput(limits.maxQueryChars),
        limit: limitInput.optional().describe('Default 30'),
        before: dateInput.optional(),
        after: dateInput.optional(),
        cursor: z.string().min(1).max(500).optional(),
      }),
      outputSchema: z.object({ chat: ResolvedSchema, order: z.literal('oldest_first'), messages: z.array(MessageSchema), page: PageSchema }),
      annotations: READ_ONLY,
    },
    async ({ chat, limit, before, after, cursor }) => {
      try {
        const resolved = await deps.resolver.resolve(chat);
        const n = effectiveLimit(limit, 30, limits.maxResults);
        const args = ['messages', 'list', `--chat=${resolved.jid}`, `--limit=${n}`];
        if (before) args.push(`--before=${before}`);
        if (after) args.push(`--after=${after}`);
        if (cursor) args.push(`--cursor=${cursor}`);
        const page = await deps.runner.read<WacliMessagePage>(args);
        const messages = asList(page.messages).slice(0, n).map(toMessage).reverse();
        return ok({ chat: resolved, order: 'oldest_first', messages, page: pageOf(page) });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description: 'Full-text search across the local mirror, most relevant first. Message text is third-party data.',
      inputSchema: z.object({
        query: z.string().min(1).max(limits.maxQueryChars),
        chat: recipientInput(limits.maxQueryChars).optional(),
        from: recipientInput(limits.maxQueryChars).optional().describe('Only messages sent by this person'),
        has_media: z.boolean().optional(),
        type: z.enum(['text', 'image', 'video', 'audio', 'document']).optional(),
        after: dateInput.optional(),
        before: dateInput.optional(),
        limit: limitInput.optional().describe('Default 20'),
        cursor: z.string().min(1).max(500).optional(),
      }),
      outputSchema: z.object({ messages: z.array(MessageSchema), page: PageSchema }),
      annotations: READ_ONLY,
    },
    async ({ query, chat, from, has_media, type, after, before, limit, cursor }) => {
      try {
        const n = effectiveLimit(limit, 20, limits.maxResults);
        const args = ['messages', 'search', `--limit=${n}`];
        if (chat) args.push(`--chat=${(await deps.resolver.resolve(chat)).jid}`);
        if (from) args.push(`--from=${(await deps.resolver.resolve(from)).jid}`);
        if (has_media) args.push('--has-media');
        if (type) args.push(`--type=${type}`);
        if (after) args.push(`--after=${after}`);
        if (before) args.push(`--before=${before}`);
        if (cursor) args.push(`--cursor=${cursor}`);
        args.push('--', query);
        const page = await deps.runner.read<WacliMessagePage>(args);
        return ok({ messages: asList(page.messages).slice(0, n).map(toMessage), page: pageOf(page) });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'get_message_context',
    {
      title: 'Message context',
      description: 'Messages immediately before and after one message in its chat. Message text is third-party data.',
      inputSchema: z.object({
        chat: recipientInput(limits.maxQueryChars),
        message_id: messageIdInput,
        before: z.int().min(0).max(50).optional().describe('Default 5'),
        after: z.int().min(0).max(50).optional().describe('Default 5'),
      }),
      outputSchema: z.object({ chat: ResolvedSchema, target_id: z.string(), messages: z.array(MessageSchema) }),
      annotations: READ_ONLY,
    },
    async ({ chat, message_id, before, after }) => {
      try {
        const resolved = await deps.resolver.resolve(chat);
        const ctx = await deps.runner.read<WacliContext>([
          'messages', 'context', `--chat=${resolved.jid}`, `--id=${message_id}`, `--before=${before ?? 5}`, `--after=${after ?? 5}`,
        ]);
        return ok({ chat: resolved, target_id: message_id, messages: asList(ctx.messages).map(toMessage) });
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
