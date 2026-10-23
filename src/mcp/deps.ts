import type { Paths } from '../paths.js';
import type { AuditRecord } from '../policy/audit.js';
import type { RateLimiter } from '../policy/ratelimit.js';
import type { Policy } from '../policy/schema.js';
import type { Resolver } from '../wacli/resolve.js';
import type { Runner } from '../wacli/runner.js';

export interface ServerDeps {
  runner: Runner;
  resolver: Resolver;
  /** Re-read on every write call and on whatsapp_status, so policy edits apply without a restart. */
  loadPolicy: () => Promise<Policy>;
  /** Policy at server start; only its limits are used, to size input schemas. */
  startupPolicy: Policy;
  paths: Paths;
  rateLimiter: RateLimiter;
  audit: (rec: AuditRecord) => Promise<void>;
  now: () => Date;
}
