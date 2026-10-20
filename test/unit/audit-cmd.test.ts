import { describe, expect, it } from 'vitest';
import { formatAudit, parseLimit, parseSince } from '../../src/ops/audit-cmd.js';
import { claudeMcpAddCommand, mcpConfigHelp, mcpConfigJson } from '../../src/ops/mcp-config.js';
import { resolvePaths } from '../../src/paths.js';

describe('audit formatting', () => {
  it('prints one line per record with outcome, tool, recipient and reason', () => {
    const text = formatAudit([
      { ts: '2026-10-20T10:00:00.000Z', tool: 'send_text', to_jid: '1@s.whatsapp.net', to_name: 'Alice', kind: 'user', outcome: 'sent', message_id: 'A', text: 'hi' },
      { ts: '2026-10-20T10:01:00.000Z', tool: 'send_text', to_jid: '1@s.whatsapp.net', to_name: null, kind: 'user', outcome: 'denied', reason: 'rate_limited' },
    ]);
    const lines = text.trim().split('\n');
    expect(lines[0]).toBe('2026-10-20T10:00:00.000Z  sent       send_text  Alice (1@s.whatsapp.net)  id=A  "hi"');
    expect(lines[1]).toBe('2026-10-20T10:01:00.000Z  denied     send_text  1@s.whatsapp.net  rate_limited');
  });
  it('strips C0 and C1 control characters from names, text, paths and the other printed fields', () => {
    const text = formatAudit([
      {
        ts: '2026-10-20T10:00:00.000Z', tool: 'send_file', to_jid: '1@s.whatsapp.net', to_name: 'Al\u001b[31mice\u0007', kind: 'user', outcome: 'sent',
        message_id: 'ID\u009b1', reason: 're\u0000ason', text: 'a\u009bb\nc\u007f', file: '/tmp/x\u0000y\r.pdf', reaction: '\u001b[2J+1',
      },
      { ts: '2026-10-20T10:01:00.000Z', tool: 'react', to_jid: '2@s.whatsapp.net', to_name: '\u001b\u0007', kind: 'user', outcome: 'denied', reason: 'rate_limited' },
    ]);
    expect(text).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('2026-10-20T10:00:00.000Z  sent       send_file  Al[31mice (1@s.whatsapp.net)  id=ID1  reason  "abc"  /tmp/xy.pdf  reaction=[2J+1');
    expect(lines[1]).toBe('2026-10-20T10:01:00.000Z  denied     react  2@s.whatsapp.net  rate_limited');
  });
  it('prints an attempted row like any other outcome', () => {
    const text = formatAudit([
      { ts: '2026-10-20T10:00:00.000Z', tool: 'send_text', to_jid: '1@s.whatsapp.net', to_name: 'Alice', kind: 'user', outcome: 'attempted', text: 'hi' },
      { ts: '2026-10-20T10:00:01.000Z', tool: 'send_text', to_jid: '1@s.whatsapp.net', to_name: 'Alice', kind: 'user', outcome: 'sent', message_id: 'A', text: 'hi' },
    ]);
    expect(text.trim().split('\n')).toEqual([
      '2026-10-20T10:00:00.000Z  attempted  send_text  Alice (1@s.whatsapp.net)  "hi"',
      '2026-10-20T10:00:01.000Z  sent       send_text  Alice (1@s.whatsapp.net)  id=A  "hi"',
    ]);
  });
  it('shows what the agent typed where a row has no JID, and (unresolved) only when nothing was recorded', () => {
    const base = { ts: '2026-10-20T10:00:00.000Z', tool: 'send_text', to_jid: null, to_name: null, kind: null } as const;
    const lines = formatAudit([
      { ...base, outcome: 'denied', reason: 'writes_disabled', to_input: 'Dave', text: 'hi' },
      { ...base, outcome: 'failed', reason: 'ambiguous_recipient', to_input: "Dave's Plumbing" },
      { ...base, outcome: 'denied', reason: 'writes_disabled' },
    ]).trim().split('\n');
    expect(lines[0]).toContain('  send_text  Dave  writes_disabled  "hi"');
    expect(lines[0]).not.toContain('(unresolved)');
    expect(lines[1]).toContain("  send_text  Dave's Plumbing  ambiguous_recipient");
    expect(lines[2]).toContain('  send_text  (unresolved)  writes_disabled');
  });

  it('prefers the JID to the input when a row has both, and strips controls from the input it prints', () => {
    const base = { ts: '2026-10-20T10:00:00.000Z', tool: 'send_text', kind: null, outcome: 'denied' } as const;
    const lines = formatAudit([
      { ...base, to_jid: '1@s.whatsapp.net', to_name: null, to_input: 'ignored' },
      { ...base, to_jid: null, to_name: null, to_input: 'Da\u001b[2Jve\u0007' },
    ]).trim().split('\n');
    expect(lines[0]).toContain('  send_text  1@s.whatsapp.net');
    expect(lines[0]).not.toContain('ignored');
    expect(lines[1]).toContain('  send_text  Da[2Jve');
    expect(lines[1]).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
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

  it('accepts YYYY-MM-DD or a full ISO 8601 timestamp, and nothing else', () => {
    expect(parseSince('2026-10-20T10:30:00Z').toISOString()).toBe('2026-10-20T10:30:00.000Z');
    expect(parseSince('2026-10-20T10:30Z').toISOString()).toBe('2026-10-20T10:30:00.000Z');
    expect(parseSince('2026-10-20T10:30:00.123+10:00').toISOString()).toBe('2026-10-20T00:30:00.123Z');
    expect(parseSince('2026-10-20T10:30:00-05:30').toISOString()).toBe('2026-10-20T16:00:00.000Z');
    expect(parseSince('2024-02-29').toISOString()).toBe('2024-02-29T00:00:00.000Z');
    const bad = [
      '2026', '2026-10', '20261020', '10/20/2026', 'Oct 20 2026', 'October 20, 2026', '2026-10-20 10:30:00', '2026-10-20T10:30:00', '2026-10-20T10:30',
      '2026-10-20T10', '2026-10-20T', 'T10:30:00Z', '2026-1-5', '2026-10-20Z', '1700000000', '', ' 2026-10-20', '2026-10-20 ', '+2026-10-20',
      '2026-02-31', '2025-02-29', '2026-04-31', '2026-13-01', '2026-00-10', '2026-10-00', '2026-10-20T25:00:00Z', '2026-10-20T10:60:00Z', '2026-02-31T10:00:00Z',
    ];
    for (const raw of bad) {
      expect(() => parseSince(raw), JSON.stringify(raw)).toThrowError(expect.objectContaining({
        code: 'invalid_input',
        message: expect.stringMatching(/YYYY-MM-DD.*ISO 8601 timestamp/),
      }));
    }
  });
});

describe('mcp config snippets', () => {
  const home = '/home/u';
  const plainCommand = 'claude mcp add --scope user whatsapp -- npx -y whatsapp-agent mcp';
  const plainJson = { mcpServers: { whatsapp: { command: 'npx', args: ['-y', 'whatsapp-agent', 'mcp'] } } };

  it('produce the Claude Code command and a JSON block', () => {
    expect(claudeMcpAddCommand()).toBe(plainCommand);
    expect(JSON.parse(mcpConfigJson())).toEqual(plainJson);
  });

  it('leave the directory variables out when the resolved dirs are the defaults', () => {
    const paths = resolvePaths({}, home);
    expect(claudeMcpAddCommand(paths, home)).toBe(plainCommand);
    expect(JSON.parse(mcpConfigJson(paths, home))).toEqual(plainJson);
    expect(mcpConfigHelp(paths, home)).not.toContain('WHATSAPP_AGENT_');
  });

  it('include both variables when both dirs differ from the defaults, quoting a value with a space', () => {
    const paths = resolvePaths({ WHATSAPP_AGENT_CONFIG_DIR: '/etc/wa cfg', WHATSAPP_AGENT_DATA_DIR: '/srv/wa' }, home);
    expect(claudeMcpAddCommand(paths, home)).toBe(
      "claude mcp add --scope user whatsapp --env WHATSAPP_AGENT_CONFIG_DIR='/etc/wa cfg' --env WHATSAPP_AGENT_DATA_DIR=/srv/wa -- npx -y whatsapp-agent mcp",
    );
    expect(JSON.parse(mcpConfigJson(paths, home))).toEqual({
      mcpServers: { whatsapp: { ...plainJson.mcpServers.whatsapp, env: { WHATSAPP_AGENT_CONFIG_DIR: '/etc/wa cfg', WHATSAPP_AGENT_DATA_DIR: '/srv/wa' } } },
    });
    expect(mcpConfigHelp(paths, home)).toContain('--env WHATSAPP_AGENT_DATA_DIR=/srv/wa');
  });

  it('include only the variable whose dir differs, and treat XDG-derived dirs as non-default', () => {
    const dataOnly = resolvePaths({ WHATSAPP_AGENT_DATA_DIR: '/srv/wa' }, home);
    expect(claudeMcpAddCommand(dataOnly, home)).toBe('claude mcp add --scope user whatsapp --env WHATSAPP_AGENT_DATA_DIR=/srv/wa -- npx -y whatsapp-agent mcp');
    const xdg = resolvePaths({ XDG_CONFIG_HOME: '/mnt/cfg' }, home);
    expect(JSON.parse(mcpConfigJson(xdg, home)).mcpServers.whatsapp.env).toEqual({ WHATSAPP_AGENT_CONFIG_DIR: '/mnt/cfg/whatsapp-agent' });
  });
});
