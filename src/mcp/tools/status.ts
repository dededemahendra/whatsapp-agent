import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { toToolError } from '../../errors.js';
import { summarizePolicy } from '../../policy/summary.js';
import { getStatus } from '../../wacli/status.js';
import type { ServerDeps } from '../deps.js';
import { ok } from '../result.js';

const StatusOutput = z.object({
  wacli_version: z.string().nullable(), min_version_ok: z.boolean(), authenticated: z.boolean(), phone: z.string().nullable(),
  connection_state: z.string().nullable(), session_revoked: z.boolean(), store_dir: z.string().nullable(),
  last_sync_at: z.string().nullable(),
  heartbeat_at: z.string().nullable().describe('Last activity: when wacli last wrote to its store. It shows recent syncing, not that the daemon is running.'),
  heartbeat_age_seconds: z.number().nullable().describe('Age of the last activity in seconds. A large value can mean the daemon stopped or the account is quiet.'),
  counts: z.object({ chats: z.number().nullable(), messages: z.number().nullable() }),
  policy: z.object({
    writes_enabled: z.boolean(), confirm: z.enum(['always', 'unlisted', 'never']), allow_count: z.number(),
    groups_enabled: z.boolean(), file_roots_count: z.number(), account: z.string().nullable(),
  }),
});

export function registerStatusTool(server: McpServer, deps: ServerDeps): void {
  server.registerTool(
    'whatsapp_status',
    {
      title: 'WhatsApp status',
      description: 'Health of the WhatsApp link: wacli version, pairing state, last sync time, last activity age, and a summary of the write policy. Last activity is when wacli last wrote to its store; it is not proof that the daemon is running. Call this first when another tool reports pairing or staleness problems.',
      outputSchema: StatusOutput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      try {
        const [status, policy] = await Promise.all([getStatus(deps.runner, deps.now()), deps.loadPolicy()]);
        return ok({ ...status, policy: summarizePolicy(policy) });
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
