import { realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Policy } from '../../src/policy/schema.js';
import { makeTmp, removeTmp } from '../helpers/fake.js';
import { errorOf, makeHarness, type Harness } from '../helpers/harness.js';

/**
 * What realpath says about one path, call by call. After the last answer it repeats the last one. Every other path goes to the real realpath.
 * This stands in for a link that is repointed between two looks at it, which cannot be timed from a test.
 */
const resolution = vi.hoisted(() => ({ path: '', answers: [] as string[], calls: 0 }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const real = actual.realpath as (...args: unknown[]) => Promise<string>;
  return {
    ...actual,
    realpath: (async (p: unknown, ...rest: unknown[]) => {
      if (p !== resolution.path) return real(p, ...rest);
      resolution.calls += 1;
      return resolution.answers[Math.min(resolution.calls, resolution.answers.length) - 1]!;
    }) as typeof actual.realpath,
  };
});

let h: Harness;
const dirs: string[] = [];
afterEach(async () => {
  resolution.path = '';
  resolution.answers = [];
  resolution.calls = 0;
  await h?.close();
  for (const d of dirs.splice(0)) await removeTmp(d);
});

const enabled = (roots: string[]) => (p: Policy): Policy => ({
  ...p, writes: { ...p.writes, enabled: true, confirm: 'never', fileRoots: roots, rateLimit: { perHour: 50, minGapSeconds: 0 } },
});

/** An outbox holding inside.pdf and a link to it, and a second folder outside every root holding secret.pdf. */
async function setup(): Promise<{ outbox: string; inside: string; link: string; secret: string }> {
  const outbox = await makeTmp('wa-outbox-');
  const elsewhere = await makeTmp('wa-elsewhere-');
  dirs.push(outbox, elsewhere);
  const link = path.join(outbox, 'link.pdf');
  await writeFile(path.join(outbox, 'inside.pdf'), 'inside');
  await writeFile(path.join(elsewhere, 'secret.pdf'), 'secret');
  // Real paths, as realpath gives them (the temp folder itself can sit under a link), because those are what the answers below stand in for.
  const inside = await realpath(path.join(outbox, 'inside.pdf'));
  const secret = await realpath(path.join(elsewhere, 'secret.pdf'));
  await symlink(inside, link);
  return { outbox, inside, link, secret };
}

describe('send_file looks up the agent\'s path once', () => {
  it('sends exactly the path it checked, even if a second look would have found something else', async () => {
    const { outbox, inside, link, secret } = await setup();
    h = await makeHarness({ policy: enabled([outbox]) });
    resolution.path = link;
    resolution.answers = [inside, secret]; // the first look finds the file in the outbox; a second would find the secret
    const r = await h.call('send_file', { to: 'Alice', path: link });
    expect(r.isError).toBeFalsy();
    const sends = (await h.argv()).filter((x) => x.key === 'send file');
    expect(sends).toHaveLength(1);
    expect(sends[0]!.argv).toContain(`--file=${inside}`);
    expect(sends[0]!.argv.join(' ')).not.toContain(secret);
    expect(resolution.calls).toBe(1);
  });

  it('refuses when that one look lands outside the roots, and sends nothing', async () => {
    const { outbox, link, secret } = await setup();
    h = await makeHarness({ policy: enabled([outbox]) });
    resolution.path = link;
    resolution.answers = [secret];
    const r = await h.call('send_file', { to: 'Alice', path: link });
    expect(errorOf(r).error).toBe('file_outside_roots');
    expect(resolution.calls).toBe(1);
    expect((await h.argv()).filter((x) => x.key === 'send file')).toHaveLength(0);
  });

  it('describes the file it checked in the prompt, and confirms what it will send', async () => {
    const { outbox, inside, link } = await setup();
    h = await makeHarness({ policy: (p) => ({ ...enabled([outbox])(p), writes: { ...enabled([outbox])(p).writes, confirm: 'always' } }) });
    resolution.path = link;
    resolution.answers = [inside];
    const r = await h.call('send_file', { to: 'Alice', path: link });
    expect(r.isError).toBeFalsy();
    expect(h.elicitations[0]).toContain(`${inside} (6 bytes)`);
    expect(resolution.calls).toBe(2); // one look in each of the two rounds of a confirmation, one per call
    const [send] = (await h.argv()).filter((x) => x.key === 'send file');
    expect(send!.argv).toContain(`--file=${inside}`);
  });
});
