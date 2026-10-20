import { describe, expect, it } from 'vitest';
import { formatAudit, parseLimit, parseSince } from '../../src/ops/audit-cmd.js';
import { claudeMcpAddCommand, mcpConfigJson } from '../../src/ops/mcp-config.js';

describe('audit formatting', () => {
  it('prints one line per record with outcome, tool, recipient and reason', () => {
    const text = formatAudit([
      { ts: '2026-10-20T10:00:00.000Z', tool: 'send_text', to_jid: '1@s.whatsapp.net', to_name: 'Alice', kind: 'user', outcome: 'sent', message_id: 'A', text: 'hi' },
      { ts: '2026-10-20T10:01:00.000Z', tool: 'send_text', to_jid: '1@s.whatsapp.net', to_name: null, kind: 'user', outcome: 'denied', reason: 'rate_limited' },
    ]);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('2026-10-20T10:00:00.000Z  sent    send_text  Alice (1@s.whatsapp.net)  id=A  "hi"');
    expect(lines[1]).toBe('2026-10-20T10:01:00.000Z  denied  send_text  1@s.whatsapp.net  rate_limited');
  });
  it('says so when empty', () => {
    expect(formatAudit([])).toBe('No audit records.\n');
  });
});

describe('audit option parsing', () => {
  it('rejects non-positive or non-numeric limits and unparseable dates', () => {
    expect(parseLimit('5')).toBe(5);
    for (const bad of ['0', '-1', 'abc', '1.5']) expect(() => parseLimit(bad)).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
    expect(parseSince('2026-10-20').toISOString()).toBe('2026-10-20T00:00:00.000Z');
    for (const bad of ['garbage', '7d']) expect(() => parseSince(bad)).toThrowError(expect.objectContaining({ code: 'invalid_input' }));
  });
});

describe('mcp config snippets', () => {
  it('produce the Claude Code command and a JSON block', () => {
    expect(claudeMcpAddCommand()).toBe('claude mcp add --scope user whatsapp -- npx -y whatsapp-agent mcp');
    expect(JSON.parse(mcpConfigJson())).toEqual({ mcpServers: { whatsapp: { command: 'npx', args: ['-y', 'whatsapp-agent', 'mcp'] } } });
  });
});
