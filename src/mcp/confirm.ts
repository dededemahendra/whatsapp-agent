import { acceptedContent, CLIENT_CAPABILITIES_META_KEY, inputRequired, inputResponse, type InputRequiredResult, type McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import type { Answer } from '../policy/engine.js';

/** The slice of the SDK handler context this module reads. Structural, so any ServerContext fits. */
export interface HandlerCtx {
  mcpReq: { envelope?: unknown; inputResponses?: Record<string, unknown> };
}

interface CapsView { elicitation?: { form?: unknown; url?: unknown } }

export const ConfirmSchema = z.object({ confirm: z.boolean().meta({ title: 'Yes, send it' }) });

/** Form elicitation is supported when `form` is declared, or when `elicitation` is a bare declaration (2025 rule). */
export function elicitationSupportsForm(caps: unknown): boolean {
  if (!caps || typeof caps !== 'object') return false;
  const e = (caps as CapsView).elicitation;
  if (!e || typeof e !== 'object') return false;
  if (e.form !== undefined) return true;
  return e.url === undefined;
}

export function clientCanConfirm(server: McpServer, ctx: HandlerCtx): boolean {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const fromEnvelope = envelope?.[CLIENT_CAPABILITIES_META_KEY];
  return elicitationSupportsForm(fromEnvelope ?? server.server.getClientCapabilities());
}

export function readAnswer(ctx: HandlerCtx): Answer {
  const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
  if (view.kind === 'missing') return 'none';
  const accepted = acceptedContent(ctx.mcpReq.inputResponses, 'confirm', ConfirmSchema);
  return accepted?.confirm === true ? 'accepted' : 'declined';
}

export function confirmationRequired(message: string): InputRequiredResult {
  return inputRequired({
    inputRequests: { confirm: inputRequired.elicit({ message, requestedSchema: ConfirmSchema }) },
  });
}
