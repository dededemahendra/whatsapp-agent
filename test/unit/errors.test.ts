import { describe, expect, it } from 'vitest';
import { AgentError, isAgentError, toToolError } from '../../src/errors.js';

describe('AgentError', () => {
  it('carries a code and details', () => {
    const e = new AgentError('rate_limited', 'Too many sends', { retry_after_seconds: 12 });
    expect(e.code).toBe('rate_limited');
    expect(e.details.retry_after_seconds).toBe(12);
    expect(isAgentError(e)).toBe(true);
    expect(isAgentError(new Error('x'))).toBe(false);
  });

  it('renders a tool error with code, message and details', () => {
    const r = toToolError(new AgentError('not_found', 'No such chat', { chat: 'x@g.us' }));
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0]!.text)).toEqual({ error: 'not_found', message: 'No such chat', chat: 'x@g.us' });
  });

  it('wraps unknown errors as wacli_error without a stack', () => {
    const r = toToolError(new Error('boom'));
    const parsed = JSON.parse(r.content[0]!.text);
    expect(parsed.error).toBe('wacli_error');
    expect(parsed.message).toBe('boom');
    expect(r.content[0]!.text).not.toContain('    at ');
  });
});
