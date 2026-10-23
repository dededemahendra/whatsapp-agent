const debugging = process.env.WHATSAPP_AGENT_LOG === 'debug';

/** One line on stderr. A log line must never change what its caller does, so nothing it runs into (a closed stderr, odd data) is allowed to throw. */
function line(message: string, data?: Record<string, unknown>): void {
  try {
    const suffix = data ? ` ${JSON.stringify(data)}` : '';
    process.stderr.write(`[whatsapp-agent] ${message}${suffix}\n`);
  } catch {
    // nothing to be done
  }
}

/** Debug line on stderr, only when WHATSAPP_AGENT_LOG=debug. Callers must pass metadata only, never message bodies. */
export function debug(message: string, data?: Record<string, unknown>): void {
  if (debugging) line(message, data);
}

/** A warning on stderr, whatever WHATSAPP_AGENT_LOG says, in the shape of a debug line. Callers must pass metadata only, never message bodies. */
export function warn(message: string, data?: Record<string, unknown>): void {
  line(message, data);
}
