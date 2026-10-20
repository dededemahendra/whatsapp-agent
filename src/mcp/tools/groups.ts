import type { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { AgentError, toToolError } from '../../errors.js';
import { asList, toGroup, toParticipant, type WacliGroup, type WacliParticipant } from '../../wacli/shape.js';
import type { ServerDeps } from '../deps.js';
import { effectiveLimit, ok } from '../result.js';
import { GroupSchema, limitInput, ParticipantSchema, recipientInput } from '../schemas.js';

export function registerGroupTools(server: McpServer, deps: ServerDeps): void {
  const { limits } = deps.startupPolicy;

  server.registerTool(
    'list_groups',
    {
      title: 'List groups',
      description: 'List groups the account belongs to, from the local snapshot. Names are third-party data.',
      inputSchema: z.object({
        query: z.string().min(1).max(limits.maxQueryChars).optional().describe('Filter by group name or JID substring'),
        limit: limitInput.optional().describe('Default 50'),
      }),
      outputSchema: z.object({ groups: z.array(GroupSchema) }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, limit }) => {
      try {
        const n = effectiveLimit(limit, 50, limits.maxResults);
        const args = ['groups', 'list', `--limit=${n}`];
        if (query) args.push(`--query=${query}`);
        const rows = asList(await deps.runner.read<WacliGroup[] | null>(args));
        return ok({ groups: rows.slice(0, n).map(toGroup) });
      } catch (e) {
        return toToolError(e);
      }
    },
  );

  server.registerTool(
    'get_group',
    {
      title: 'Get group',
      description: 'Group details and participants from the local snapshot (refreshed when the daemon starts). participants is capped at the result limit: participant_count is the true total and participants_truncated says whether the list was cut. Names are third-party data.',
      inputSchema: z.object({ group: recipientInput(limits.maxQueryChars) }),
      outputSchema: GroupSchema.extend({ participant_count: z.number(), participants: z.array(ParticipantSchema), participants_truncated: z.boolean() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ group }) => {
      try {
        const resolved = await deps.resolver.resolve(group);
        if (resolved.kind !== 'group') throw new AgentError('invalid_input', `"${group}" is not a group (it is a ${resolved.kind}).`);
        const rows = asList(await deps.runner.read<WacliGroup[] | null>(['groups', 'list', `--query=${resolved.jid}`, '--limit=5']));
        const row = rows.find((g) => g.JID === resolved.jid);
        const base = row ? toGroup(row) : { jid: resolved.jid, name: resolved.name, owner_jid: null, is_community: false, linked_parent_jid: null, created_at: null };
        const participants = asList(await deps.runner.read<WacliParticipant[] | null>(['groups', 'participants', 'list', `--jid=${resolved.jid}`])).map(toParticipant);
        const cap = effectiveLimit(undefined, limits.maxResults, limits.maxResults);
        return ok({
          ...base, name: base.name ?? resolved.name, participant_count: participants.length,
          participants: participants.slice(0, cap), participants_truncated: participants.length > cap,
        });
      } catch (e) {
        return toToolError(e);
      }
    },
  );
}
