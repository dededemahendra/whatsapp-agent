import { AgentError } from '../errors.js';

/** A positive whole number given on the command line (digits only, no sign, no zero), or invalid_input naming the flag. */
export function parsePositiveInt(raw: string, flag: string): number {
  if (!/^[1-9]\d*$/.test(raw)) throw new AgentError('invalid_input', `${flag} must be a positive whole number`);
  return Number(raw);
}
