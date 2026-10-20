export function claudeMcpAddCommand(): string {
  return 'claude mcp add --scope user whatsapp -- npx -y whatsapp-agent mcp';
}

export function mcpConfigJson(): string {
  return JSON.stringify({ mcpServers: { whatsapp: { command: 'npx', args: ['-y', 'whatsapp-agent', 'mcp'] } } }, null, 2);
}

export function mcpConfigHelp(): string {
  return [
    'Connect an agent host:',
    `  Claude Code:                 ${claudeMcpAddCommand()}`,
    '  Claude Desktop or Cursor:    add this to the host\'s MCP settings file:',
    ...mcpConfigJson().split('\n').map((l) => `    ${l}`),
    '  A global install (npm i -g whatsapp-agent) avoids npx start-up delay and is required for daemon install.',
  ].join('\n');
}
