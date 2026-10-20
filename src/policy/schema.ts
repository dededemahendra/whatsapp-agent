import { chmod, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import { AgentError } from '../errors.js';
import { ensurePrivateDir } from '../paths.js';

export const PolicySchema = z.strictObject({
  version: z.literal(1),
  account: z.string().min(1).nullable(),
  writes: z.strictObject({
    enabled: z.boolean(),
    confirm: z.enum(['always', 'unlisted', 'never']),
    allow: z.array(z.string().min(1)).max(500),
    groups: z.boolean(),
    rateLimit: z.strictObject({
      perHour: z.int().min(1).max(1000),
      minGapSeconds: z.int().min(0).max(3600),
    }),
    fileRoots: z.array(z.string().min(1)).max(50),
  }),
  limits: z.strictObject({
    maxResults: z.int().min(1).max(200),
    maxQueryChars: z.int().min(10).max(1000),
    maxMessageChars: z.int().min(1).max(4096),
  }),
  media: z.strictObject({
    inlineImageMaxBytes: z.int().min(0).max(10_000_000),
  }),
  daemon: z.strictObject({
    presenceMode: z.enum(['quiet', 'normal']),
    sendSpacing: z.string().regex(/^\d+(ms|s|m)(-\d+(ms|s|m))?$/),
    staleThreshold: z.string().regex(/^\d+(s|m)$/),
    maxDbSize: z.string().regex(/^\d+(MB|GB)$/),
    downloadMedia: z.boolean(),
  }),
});

export type Policy = z.infer<typeof PolicySchema>;
export type ConfirmMode = Policy['writes']['confirm'];

export const DEFAULT_POLICY: Policy = {
  version: 1,
  account: null,
  writes: {
    enabled: false,
    confirm: 'always',
    allow: [],
    groups: false,
    rateLimit: { perHour: 20, minGapSeconds: 5 },
    fileRoots: [],
  },
  limits: { maxResults: 50, maxQueryChars: 200, maxMessageChars: 4000 },
  media: { inlineImageMaxBytes: 1_500_000 },
  daemon: {
    presenceMode: 'quiet',
    sendSpacing: '2s-6s',
    staleThreshold: '2m',
    maxDbSize: '2GB',
    downloadMedia: false,
  },
};

export async function loadPolicy(file: string): Promise<Policy> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(DEFAULT_POLICY);
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AgentError('invalid_input', `${file} is not valid JSON`);
  }
  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new AgentError('invalid_input', `${file} is invalid: ${issues}`);
  }
  return result.data;
}

export async function savePolicy(file: string, policy: Policy): Promise<void> {
  const data = PolicySchema.parse(policy);
  await ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}
