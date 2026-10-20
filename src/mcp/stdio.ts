import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { ensureDirs, resolvePaths, type Paths } from '../paths.js';
import { appendAudit } from '../policy/audit.js';
import { createRateLimiter } from '../policy/ratelimit.js';
import { loadPolicy, type Policy } from '../policy/schema.js';
import { createResolver } from '../wacli/resolve.js';
import { createRunner } from '../wacli/runner.js';
import type { ServerDeps } from './deps.js';
import { createServer } from './server.js';

export async function buildDeps(env: NodeJS.ProcessEnv = process.env): Promise<{ deps: ServerDeps; paths: Paths; policy: Policy }> {
  const paths = resolvePaths(env);
  await ensureDirs(paths);
  const policy = await loadPolicy(paths.policyFile);
  const runner = createRunner({ bin: env.WHATSAPP_AGENT_WACLI_BIN || 'wacli', account: policy.account, baseEnv: env });
  const deps: ServerDeps = {
    runner,
    resolver: createResolver(runner),
    loadPolicy: () => loadPolicy(paths.policyFile),
    startupPolicy: policy,
    paths,
    rateLimiter: createRateLimiter(paths.rateLimitFile),
    audit: (rec) => appendAudit(paths.auditFile, rec),
    now: () => new Date(),
  };
  return { deps, paths, policy };
}

export async function runMcpServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const { deps } = await buildDeps(env);
  const server = createServer(deps);
  await server.connect(new StdioServerTransport());
  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
