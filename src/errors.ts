export type ErrorCode =
  | 'wacli_not_installed'
  | 'wacli_too_old'
  | 'not_authenticated'
  | 'session_logged_out'
  | 'store_locked'
  | 'writes_disabled'
  | 'groups_disabled'
  | 'unsupported_target'
  | 'file_outside_roots'
  | 'rate_limited'
  | 'confirmation_unavailable'
  | 'confirmation_declined'
  | 'ambiguous_recipient'
  | 'not_found'
  | 'timeout'
  | 'invalid_input'
  | 'wacli_error';

export class AgentError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.details = details;
  }
}

export function isAgentError(e: unknown): e is AgentError {
  return e instanceof AgentError;
}

export type ToolErrorResult = { isError: true; content: Array<{ type: 'text'; text: string }> };

export function toToolError(e: unknown): ToolErrorResult {
  const err = isAgentError(e)
    ? e
    : new AgentError('wacli_error', e instanceof Error ? e.message : String(e));
  const body = { error: err.code, message: err.message, ...err.details };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
}
