import { describe, expect, it } from 'vitest';
import { elicitationSupportsForm } from '../../src/mcp/confirm.js';

describe('elicitationSupportsForm', () => {
  it('treats a bare elicitation declaration as form support (2025 rule)', () => {
    expect(elicitationSupportsForm({ elicitation: {} })).toBe(true);
  });
  it('accepts explicit form support', () => {
    expect(elicitationSupportsForm({ elicitation: { form: {} } })).toBe(true);
    expect(elicitationSupportsForm({ elicitation: { form: {}, url: {} } })).toBe(true);
  });
  it('rejects url-only, absent and malformed capabilities', () => {
    expect(elicitationSupportsForm({ elicitation: { url: {} } })).toBe(false);
    expect(elicitationSupportsForm({})).toBe(false);
    expect(elicitationSupportsForm(undefined)).toBe(false);
    expect(elicitationSupportsForm('nope')).toBe(false);
  });
});
