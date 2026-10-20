import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CallToolResult, InputRequiredResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { AgentError, toToolError } from '../../errors.js';
import { debug } from '../../log.js';
import type { AuditRecord } from '../../policy/audit.js';
import { DENY_MESSAGES, decide, fileInsideRoots, type Decision, type WriteTool } from '../../policy/engine.js';
import type { Resolved } from '../../wacli/resolve.js';
import type { WacliChatStateResult, WacliSendResult } from '../../wacli/shape.js';
import {
  clientCanConfirm, confirmationRequired, filePrompt, fileState, reactPrompt, reactState, readAnswer, textPrompt, textState,
  type ConfirmState, type FileSend, type HandlerCtx, type ReactSend, type TextSend,
} from '../confirm.js';
import type { ServerDeps } from '../deps.js';
import { ok } from '../result.js';
import { messageIdInput, recipientInput, ResolvedSchema, SendResultSchema } from '../schemas.js';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const POLICY_NOTE = "Subject to the person's policy: may be disabled, may require their confirmation, and is rate limited. A denial is final; report it rather than retrying.";

type Deny = Extract<Decision, { kind: 'deny' }>;

/** Write gates run one at a time per process, so two concurrent sends cannot both pass the rate-limit check. */
let writeChain: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeChain.then(fn, fn);
  writeChain = next.catch(() => undefined);
  return next;
}

/** Writes between the gate letting them through and their last audit row. A stop waits for these (see drainInFlight) so a send is not cut off before it is recorded. */
let inFlight = 0;
const idleWaiters = new Set<() => void>();

/** Counts one write as in flight. The function it returns ends it, and may be called more than once. */
function hold(): () => void {
  inFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    inFlight -= 1;
    if (inFlight === 0) for (const wake of [...idleWaiters]) wake();
  };
}

/** Resolves when no write is in flight, or after `timeoutMs`, whichever comes first. */
export function drainInFlight(timeoutMs: number): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      idleWaiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    idleWaiters.add(done);
  });
}

/** What a file send will read: where the file really is, how big it is and when it last changed. Null when it cannot be found. */
async function fileFacts(file: string): Promise<Pick<FileSend, 'realPath' | 'size' | 'mtimeMs'> | null> {
  try {
    const real = await realpath(file);
    const s = await stat(real);
    return { realPath: real, size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

export function registerWriteTools(server: McpServer, deps: ServerDeps): void {
  const { limits } = deps.startupPolicy;
  const base = (tool: WriteTool, r: Resolved | null): AuditRecord => ({
    ts: deps.now().toISOString(), tool, to_jid: r?.jid ?? null, to_name: r?.name ?? null, kind: r?.kind ?? null, outcome: 'sent',
    client: server.server.getClientVersion()?.name,
  });

  /** Audit failures never change a tool result: a completed send must not be reported as failed. */
  async function record(rec: AuditRecord): Promise<void> {
    try {
      await deps.audit(rec);
    } catch (e) {
      debug('audit append failed', { tool: rec.tool, outcome: rec.outcome, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Decides, and when the decision is allow, records the send inside the same serialised section. mark_read is not rate limited.
   * `expect` is what this call would send: an accept counts only if the state it came back with was minted for exactly that.
   */
  async function gate(ctx: HandlerCtx, tool: WriteTool, recipient: Resolved, extra: { fileInsideRoots?: boolean; expect?: ConfirmState } = {}): Promise<Decision> {
    return serialised(async () => {
      const policy = await deps.loadPolicy();
      const rate = await deps.rateLimiter.snapshot(deps.now());
      const answer = extra.expect ? readAnswer(ctx, extra.expect) : 'none';
      const decision = decide({ policy, tool, recipient, fileInsideRoots: extra.fileInsideRoots, rate, clientCanConfirm: clientCanConfirm(server, ctx), answer });
      if (decision.kind === 'allow' && tool !== 'mark_read') await deps.rateLimiter.record(deps.now());
      return decision;
    });
  }

  async function denied(tool: WriteTool, recipient: Resolved | null, d: Deny, extra: Partial<AuditRecord>): Promise<CallToolResult> {
    await record({ ...base(tool, recipient), outcome: 'denied', reason: d.code, ...extra });
    return toToolError(new AgentError(d.code, d.message, d.retryAfterSeconds === undefined ? {} : { retry_after_seconds: d.retryAfterSeconds }));
  }

  /**
   * Writes the row that says a send is about to be handed to wacli. Unlike the rows that follow, this one is required: when it cannot be
   * written the send does not happen, so nothing leaves unrecorded. (It comes before the send, so it never hides one that happened.)
   */
  async function attempt(tool: WriteTool, recipient: Resolved, extra: Partial<AuditRecord>): Promise<void> {
    try {
      await deps.audit({ ...base(tool, recipient), outcome: 'attempted', ...extra });
    } catch (e) {
      const why = (e instanceof Error ? e.message : String(e)).replace(/[\s.]+$/, '');
      throw new AgentError('invalid_input', `Could not write the audit log at ${deps.paths.auditFile}: ${why}. Nothing was sent.`);
    }
  }

  /** The master switch, read before the recipient is looked up, so a switched-off server does not query wacli for a write it will refuse. */
  async function switchedOff(tool: WriteTool, extra: Partial<AuditRecord>): Promise<CallToolResult | null> {
    if ((await deps.loadPolicy()).writes.enabled) return null;
    return denied(tool, null, { kind: 'deny', code: 'writes_disabled', message: DENY_MESSAGES.writes_disabled }, extra);
  }

  async function failed(tool: WriteTool, recipient: Resolved | null, e: unknown, extra: Partial<AuditRecord>): Promise<CallToolResult> {
    await record({ ...base(tool, recipient), outcome: 'failed', reason: e instanceof AgentError ? e.code : 'error', ...extra });
    return toToolError(e);
  }

  server.registerTool(
    'send_text',
    {
      title: 'Send a message',
      description: `Send a text message to a person or group. ${POLICY_NOTE}`,
      inputSchema: z.object({
        to: recipientInput(limits.maxQueryChars),
        message: z.string().min(1).max(limits.maxMessageChars),
        reply_to: messageIdInput.optional().describe('Quote this message id'),
        reply_to_sender: z.string().min(1).max(200).optional().describe('Sender JID of the quoted message, for groups'),
        mentions: z.array(z.string().min(6).max(50)).max(20).optional().describe('Phone numbers or JIDs to @mention'),
        link_preview: z.boolean().optional().describe('Default true'),
      }),
      outputSchema: SendResultSchema,
      annotations: WRITE,
    },
    async (a, ctx): Promise<CallToolResult | InputRequiredResult> => {
      let recipient: Resolved | null = null;
      let release: (() => void) | null = null;
      try {
        const off = await switchedOff('send_text', { text: a.message });
        if (off) return off;
        recipient = await deps.resolver.resolve(a.to, { exact: true });
        const send: TextSend = { text: a.message, replyTo: a.reply_to, replyToSender: a.reply_to_sender, mentions: a.mentions, linkPreview: a.link_preview };
        const state = textState(recipient, send);
        const d = await gate(ctx, 'send_text', recipient, { expect: state });
        if (d.kind === 'deny') return denied('send_text', recipient, d, { text: a.message });
        if (d.kind === 'confirm') return await confirmationRequired(textPrompt(recipient, send), state);
        release = hold();
        const argv = ['send', 'text', `--to=${recipient.jid}`, `--message=${a.message}`];
        if (a.reply_to) argv.push(`--reply-to=${a.reply_to}`);
        if (a.reply_to_sender) argv.push(`--reply-to-sender=${a.reply_to_sender}`);
        for (const m of a.mentions ?? []) argv.push(`--mention=${m}`);
        if (a.link_preview === false) argv.push('--no-preview');
        await attempt('send_text', recipient, { text: a.message });
        const res = await deps.runner.write<WacliSendResult>(argv);
        await record({ ...base('send_text', recipient), outcome: 'sent', message_id: res.id, text: a.message });
        return ok({ sent: true, message_id: res.id, to: recipient, timestamp: deps.now().toISOString() });
      } catch (e) {
        return await failed('send_text', recipient, e, { text: a.message });
      } finally {
        release?.();
      }
    },
  );

  server.registerTool(
    'send_file',
    {
      title: 'Send a file',
      description: `Send an image, video, audio file or document from an allowed local folder. ${POLICY_NOTE}`,
      inputSchema: z.object({
        to: recipientInput(limits.maxQueryChars),
        path: z.string().min(1).max(1000).refine((p) => path.isAbsolute(p), 'path must be absolute'),
        caption: z.string().max(limits.maxMessageChars).optional(),
        as: z.enum(['auto', 'document', 'image', 'video', 'audio']).optional(),
        filename: z.string().min(1).max(255).optional(),
      }),
      outputSchema: SendResultSchema,
      annotations: WRITE,
    },
    async (a, ctx): Promise<CallToolResult | InputRequiredResult> => {
      let recipient: Resolved | null = null;
      let release: (() => void) | null = null;
      try {
        const off = await switchedOff('send_file', { file: a.path });
        if (off) return off;
        recipient = await deps.resolver.resolve(a.to, { exact: true });
        const policy = await deps.loadPolicy();
        const facts = (await fileInsideRoots(a.path, policy.writes.fileRoots)) ? await fileFacts(a.path) : null;
        // Without facts the file is treated as outside the roots, so the gate refuses before these placeholder values are looked at.
        const send: FileSend = { ...(facts ?? { realPath: a.path, size: 0, mtimeMs: 0 }), caption: a.caption, as: a.as, filename: a.filename };
        const state = fileState(recipient, send);
        const d = await gate(ctx, 'send_file', recipient, { fileInsideRoots: facts !== null, expect: state });
        if (d.kind === 'deny') return denied('send_file', recipient, d, { file: a.path });
        if (d.kind === 'confirm') return await confirmationRequired(filePrompt(recipient, send), state);
        release = hold();
        const argv = ['send', 'file', `--to=${recipient.jid}`, `--file=${a.path}`];
        if (a.caption) argv.push(`--caption=${a.caption}`);
        if (a.as && a.as !== 'auto') argv.push(`--as=${a.as}`);
        if (a.filename) argv.push(`--filename=${a.filename}`);
        const env: Record<string, string> = policy.writes.fileRoots.length > 0 ? { WACLI_MEDIA_ROOTS: policy.writes.fileRoots.join(path.delimiter) } : {};
        await attempt('send_file', recipient, { file: a.path, text: a.caption });
        const res = await deps.runner.write<WacliSendResult>(argv, { env });
        await record({ ...base('send_file', recipient), outcome: 'sent', message_id: res.id, file: a.path, text: a.caption });
        return ok({ sent: true, message_id: res.id, to: recipient, timestamp: deps.now().toISOString() });
      } catch (e) {
        return await failed('send_file', recipient, e, { file: a.path });
      } finally {
        release?.();
      }
    },
  );

  server.registerTool(
    'react',
    {
      title: 'React to a message',
      description: `Add an emoji reaction to a message, or clear it with an empty string. ${POLICY_NOTE}`,
      inputSchema: z.object({
        chat: recipientInput(limits.maxQueryChars),
        message_id: messageIdInput,
        reaction: z.string().max(32).refine((s) => [...s].length <= 8, 'At most 8 characters'),
        sender: z.string().min(1).max(200).optional().describe('Original sender JID, for group messages'),
      }),
      outputSchema: z.object({ sent: z.literal(true), message_id: z.string(), to: ResolvedSchema }),
      annotations: WRITE,
    },
    async (a, ctx): Promise<CallToolResult | InputRequiredResult> => {
      let recipient: Resolved | null = null;
      let release: (() => void) | null = null;
      try {
        const off = await switchedOff('react', { reaction: a.reaction, message_id: a.message_id });
        if (off) return off;
        recipient = await deps.resolver.resolve(a.chat, { exact: true });
        const send: ReactSend = { reaction: a.reaction, messageId: a.message_id, sender: a.sender };
        const state = reactState(recipient, send);
        const d = await gate(ctx, 'react', recipient, { expect: state });
        if (d.kind === 'deny') return denied('react', recipient, d, { reaction: a.reaction, message_id: a.message_id });
        if (d.kind === 'confirm') return await confirmationRequired(reactPrompt(recipient, send), state);
        release = hold();
        const argv = ['send', 'react', `--to=${recipient.jid}`, `--id=${a.message_id}`, `--reaction=${a.reaction}`];
        if (a.sender) argv.push(`--sender=${a.sender}`);
        await attempt('react', recipient, { reaction: a.reaction, message_id: a.message_id });
        const res = await deps.runner.write<WacliSendResult>(argv);
        await record({ ...base('react', recipient), outcome: 'sent', message_id: a.message_id, reaction: a.reaction });
        return ok({ sent: true, message_id: res.id, to: recipient });
      } catch (e) {
        return await failed('react', recipient, e, { reaction: a.reaction, message_id: a.message_id });
      } finally {
        release?.();
      }
    },
  );

  server.registerTool(
    'mark_read',
    {
      title: 'Mark a chat read',
      description: 'Mark a chat as read. Requires writes to be enabled; never prompts.',
      inputSchema: z.object({ chat: recipientInput(limits.maxQueryChars) }),
      outputSchema: z.object({ ok: z.literal(true), chat: ResolvedSchema }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (a, ctx): Promise<CallToolResult> => {
      let recipient: Resolved | null = null;
      let release: (() => void) | null = null;
      try {
        const off = await switchedOff('mark_read', {});
        if (off) return off;
        recipient = await deps.resolver.resolve(a.chat, { exact: true });
        const d = await gate(ctx, 'mark_read', recipient);
        if (d.kind === 'deny') return denied('mark_read', recipient, d, {});
        release = hold();
        await attempt('mark_read', recipient, {});
        await deps.runner.write<WacliChatStateResult>(['chats', 'mark-read', `--chat=${recipient.jid}`], { idempotent: true });
        await record({ ...base('mark_read', recipient), outcome: 'sent' });
        return ok({ ok: true, chat: recipient });
      } catch (e) {
        return await failed('mark_read', recipient, e, {});
      } finally {
        release?.();
      }
    },
  );
}
