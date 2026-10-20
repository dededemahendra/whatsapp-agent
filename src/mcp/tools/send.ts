import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { CallToolResult, InputRequiredResult, McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { AgentError, toToolError } from '../../errors.js';
import { debug } from '../../log.js';
import { auditInput, type AuditRecord } from '../../policy/audit.js';
import { DENY_MESSAGES, decide, fileInsideRoots, type Decision, type WriteTool } from '../../policy/engine.js';
import type { Policy } from '../../policy/schema.js';
import type { Resolved } from '../../wacli/resolve.js';
import { SEND_UNCERTAIN, type RunOptions } from '../../wacli/runner.js';
import type { WacliChatStateResult, WacliSendResult } from '../../wacli/shape.js';
import {
  clientCanConfirm, confirmationRequired, filePrompt, fileState, reactPrompt, reactState, readAnswer, textPrompt, textState,
  type ConfirmBinding, type FileSend, type HandlerCtx, type ReactSend, type TextSend,
} from '../confirm.js';
import type { ServerDeps } from '../deps.js';
import { ok } from '../result.js';
import { messageIdInput, recipientInput, ResolvedSchema, SendResultSchema } from '../schemas.js';

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;
const POLICY_NOTE = "Subject to the person's policy: may be disabled, may require their confirmation, and is rate limited. A denial is final, except rate_limited, which says when to retry; report any other denial rather than retrying.";

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

/** How far a call got. `sent` is set once wacli has run to the end, or may have: whatever fails after that is reported as uncertain. */
interface Progress { sent: boolean }

const UNCERTAIN_REASON = ' (outcome uncertain, may have been delivered)';
const isUncertain = (e: unknown): boolean => e instanceof AgentError && e.details.outcome_uncertain === true;

/** The error with the uncertain wording and flag, unless it has them already. A plain error becomes a wacli_error, as toToolError would make it. */
function asUncertain(e: unknown): AgentError {
  const err = e instanceof AgentError ? e : new AgentError('wacli_error', e instanceof Error ? e.message : String(e));
  if (isUncertain(err)) return err;
  const message = err.message.includes('may have gone through') ? err.message : `${err.message.replace(/[\s.]+$/, '')}. ${SEND_UNCERTAIN}`;
  return new AgentError(err.code, message, { ...err.details, outcome_uncertain: true });
}

/** The id wacli reported, or an empty string when its answer carries none. */
const idOf = (res: Partial<WacliSendResult> | null | undefined): string => (typeof res?.id === 'string' ? res.id : '');

/**
 * The roots as they really are on disk, so a root under a symlinked directory (macOS /tmp and /var, a linked Outbox) matches real file
 * paths in our own check and in the check wacli makes with the same list. A root that does not exist is kept as configured.
 */
const realRoots = (roots: string[]): Promise<string[]> => Promise.all(roots.map((root) => realpath(root).catch(() => root)));

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

  /** The audit log's own failure, worded for whoever reads stderr. The reason is trimmed of trailing full stops so the sentence ends once. */
  const unwritable = (e: unknown): string => `Could not write the audit log at ${deps.paths.auditFile}: ${(e instanceof Error ? e.message : String(e)).replace(/[\s.]+$/, '')}`;

  /**
   * Rows for denials, failures and the sent row: the result already says what happened, and a delivered send is reported as sent whatever
   * becomes of its row, so a row that cannot be written is logged and nothing else changes. (The logger has one level, debug.)
   */
  async function record(rec: AuditRecord): Promise<void> {
    try {
      await deps.audit(rec);
    } catch (e) {
      debug(unwritable(e), { tool: rec.tool, outcome: rec.outcome });
    }
  }

  /**
   * Decides, and when the decision is allow, records the send inside the same serialised section. mark_read is not rate limited.
   * `expect` is what this call would send: an accept counts only if the state it came back with was minted for exactly that.
   * `policy` is the snapshot the caller already used for its own checks; without one the policy is read here.
   */
  async function gate(ctx: HandlerCtx, tool: WriteTool, recipient: Resolved, extra: { policy?: Policy; fileInsideRoots?: boolean; expect?: ConfirmBinding } = {}): Promise<Decision> {
    return serialised(async () => {
      const policy = extra.policy ?? await deps.loadPolicy();
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
   * Writes the row that says a write is about to be handed to wacli. This one is required: when it cannot be written the write does not
   * happen, so nothing leaves unrecorded. It comes before the write, so it never hides one that happened.
   */
  async function attempt(tool: WriteTool, recipient: Resolved, extra: Partial<AuditRecord>): Promise<void> {
    try {
      await deps.audit({ ...base(tool, recipient), outcome: 'attempted', ...extra });
    } catch (e) {
      throw new AgentError('invalid_input', `${unwritable(e)}. Nothing was sent.`);
    }
  }

  /**
   * Hands the message to wacli. A failure the runner reports keeps the runner's own verdict: it marks the doubtful ones uncertain and gives
   * the rest (not paired, store locked, a flag wacli does not know, a spawn that never started, a NUL byte) a definite code. Once this
   * returns, or ends in something that is not a runner error, whatever fails next is uncertain.
   */
  async function write<T>(progress: Progress, argv: string[], opts?: RunOptions): Promise<T> {
    try {
      const res = await deps.runner.write<T>(argv, opts);
      progress.sent = true;
      return res;
    } catch (e) {
      if (!(e instanceof AgentError)) progress.sent = true;
      throw e;
    }
  }

  /** The master switch, read before the recipient is looked up, so a switched-off server does not query wacli for a write it will refuse. */
  async function switchedOff(tool: WriteTool, input: string, extra: Partial<AuditRecord>): Promise<CallToolResult | null> {
    if ((await deps.loadPolicy()).writes.enabled) return null;
    return denied(tool, null, { kind: 'deny', code: 'writes_disabled', message: DENY_MESSAGES.writes_disabled }, { to_input: auditInput(input), ...extra });
  }

  /** `input` is what the agent called the recipient; it goes on the row only while there is no JID to name the recipient by. */
  async function failed(progress: Progress, tool: WriteTool, recipient: Resolved | null, e: unknown, extra: Partial<AuditRecord>, input: string): Promise<CallToolResult> {
    const error = progress.sent ? asUncertain(e) : e;
    const uncertain = isUncertain(error);
    const code = error instanceof AgentError ? error.code : 'error';
    await record({
      ...base(tool, recipient), ...(recipient === null ? { to_input: auditInput(input) } : {}),
      outcome: 'failed', reason: uncertain ? `${code}${UNCERTAIN_REASON}` : code, ...(uncertain ? { uncertain: true } : {}), ...extra,
    });
    return toToolError(error);
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
      const progress: Progress = { sent: false };
      try {
        const off = await switchedOff('send_text', a.to, { text: a.message });
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
        const id = idOf(await write<Partial<WacliSendResult> | null>(progress, argv));
        await record({ ...base('send_text', recipient), outcome: 'sent', ...(id ? { message_id: id } : {}), text: a.message });
        return ok({ sent: true, message_id: id, to: recipient, timestamp: deps.now().toISOString() });
      } catch (e) {
        return await failed(progress, 'send_text', recipient, e, { text: a.message }, a.to);
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
      const progress: Progress = { sent: false };
      try {
        const off = await switchedOff('send_file', a.to, { file: a.path });
        if (off) return off;
        recipient = await deps.resolver.resolve(a.to, { exact: true });
        // One snapshot of the policy serves the file check, the decision and the roots handed to wacli, so they cannot disagree.
        const policy = await deps.loadPolicy();
        const roots = await realRoots(policy.writes.fileRoots);
        const facts = (await fileInsideRoots(a.path, roots)) ? await fileFacts(a.path) : null;
        // Without facts the file is treated as outside the roots, so the gate refuses before these placeholder values are looked at.
        const send: FileSend = { ...(facts ?? { realPath: a.path, size: 0, mtimeMs: 0 }), caption: a.caption, as: a.as, filename: a.filename };
        const state = fileState(recipient, send);
        const d = await gate(ctx, 'send_file', recipient, { policy, fileInsideRoots: facts !== null, expect: state });
        if (d.kind === 'deny') return denied('send_file', recipient, d, { file: a.path });
        if (d.kind === 'confirm') return await confirmationRequired(filePrompt(recipient, send), state);
        release = hold();
        const argv = ['send', 'file', `--to=${recipient.jid}`, `--file=${send.realPath}`]; // the path that was vetted, not the one the agent gave
        if (a.caption) argv.push(`--caption=${a.caption}`);
        if (a.as && a.as !== 'auto') argv.push(`--as=${a.as}`);
        if (a.filename) argv.push(`--filename=${a.filename}`);
        const env: Record<string, string> = roots.length > 0 ? { WACLI_MEDIA_ROOTS: roots.join(path.delimiter) } : {};
        await attempt('send_file', recipient, { file: a.path, text: a.caption });
        const id = idOf(await write<Partial<WacliSendResult> | null>(progress, argv, { env }));
        await record({ ...base('send_file', recipient), outcome: 'sent', ...(id ? { message_id: id } : {}), file: a.path, text: a.caption });
        return ok({ sent: true, message_id: id, to: recipient, timestamp: deps.now().toISOString() });
      } catch (e) {
        return await failed(progress, 'send_file', recipient, e, { file: a.path }, a.to);
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
      const progress: Progress = { sent: false };
      try {
        const off = await switchedOff('react', a.chat, { reaction: a.reaction, message_id: a.message_id });
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
        const id = idOf(await write<Partial<WacliSendResult> | null>(progress, argv));
        await record({ ...base('react', recipient), outcome: 'sent', message_id: a.message_id, reaction: a.reaction });
        return ok({ sent: true, message_id: id, to: recipient });
      } catch (e) {
        return await failed(progress, 'react', recipient, e, { reaction: a.reaction, message_id: a.message_id }, a.chat);
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
      const progress: Progress = { sent: false }; // marking a chat read can be repeated, so a failure here is never uncertain
      try {
        const off = await switchedOff('mark_read', a.chat, {});
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
        return await failed(progress, 'mark_read', recipient, e, {}, a.chat);
      } finally {
        release?.();
      }
    },
  );
}
