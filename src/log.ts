const enabled = process.env.WHATSAPP_AGENT_LOG === 'debug';

/** Debug line on stderr. Callers must pass metadata only, never message bodies. */
export function debug(message: string, data?: Record<string, unknown>): void {
  if (!enabled) return;
  const suffix = data ? ` ${JSON.stringify(data)}` : '';
  process.stderr.write(`[whatsapp-agent] ${message}${suffix}\n`);
}
