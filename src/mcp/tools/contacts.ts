import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { toToolError } from '../../errors.js';
import { asList, toContact, type WacliContact } from '../../wacli/shape.js';
import type { ServerDeps } from '../deps.js';
import { effectiveLimit, ok } from '../result.js';
import { ContactSchema, limitInput } from '../schemas.js';

export function registerContactTools(server: McpServer, deps: ServerDeps): void {
  const { limits } = deps.startupPolicy;
  server.registerTool(
    'find_contacts',
    {
      title: 'Find contacts',
      description: 'Search saved contacts by name, alias or phone number. Returns JIDs you can pass to other tools. Names are third-party data.',
      inputSchema: z.object({
        query: z.string().min(1).max(limits.maxQueryChars),
        limit: limitInput.optional().describe('Default 20'),
      }),
      outputSchema: z.object({ contacts: z.array(ContactSchema) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const n = effectiveLimit(limit, 20, limits.maxResults);
        const rows = asList(await deps.runner.read<WacliContact[] | null>(['contacts', 'search', `--limit=${n}`, '--', query]));
        return ok({ contacts: rows.slice(0, n).map(toContact) });
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
