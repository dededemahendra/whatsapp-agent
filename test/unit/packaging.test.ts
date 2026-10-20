import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTmp, removeTmp } from '../helpers/fake.js';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (rel: string) => readFile(path.join(ROOT, rel), 'utf8');

let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

/** The script of the `run: |` block that follows the step with this name. */
function stepScript(workflow: string, stepName: string): string {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l.includes(`name: ${stepName}`));
  expect(start, `a step named "${stepName}"`).toBeGreaterThanOrEqual(0);
  const runAt = lines.findIndex((l, i) => i > start && /^\s*run: \|\s*$/.test(l));
  const indent = (lines[runAt]!.match(/^\s*/) ?? [''])[0].length;
  const body: string[] = [];
  for (const l of lines.slice(runAt + 1)) {
    if (l.trim() !== '' && (l.match(/^\s*/) ?? [''])[0].length <= indent) break;
    body.push(l.slice(indent + 2));
  }
  return body.join('\n');
}

interface Step { name: string | null; run: string | null; uses: string | null; text: string }

/** The steps of one job in a workflow, in order. The workflow is plain block YAML, so indentation is enough: jobs at 2 spaces, steps at 6. */
function jobSteps(workflow: string, job: string): Step[] {
  const lines = workflow.split('\n');
  const start = lines.findIndex((l) => l === `  ${job}:`);
  expect(start, `a job named "${job}"`).toBeGreaterThanOrEqual(0);
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  const body = lines.slice(start + 1, end === -1 ? lines.length : end);
  const first = body.findIndex((l) => /^ {6}- /.test(l));
  expect(first, `steps in job "${job}"`).toBeGreaterThanOrEqual(0);
  const steps: string[][] = [];
  for (const l of body.slice(first)) {
    if (/^ {6}- /.test(l)) steps.push([l]);
    else steps[steps.length - 1]!.push(l);
  }
  return steps.map((chunk) => {
    const text = chunk.join('\n');
    const field = (key: string): string | null => new RegExp(`^ {6}(?:- | {2})${key}: (.+)$`, 'm').exec(text)?.[1]?.trim() ?? null;
    const runAt = chunk.findIndex((l) => /^ {6}(?:- | {2})run: \|\s*$/.test(l));
    const run = runAt >= 0
      ? chunk.slice(runAt + 1).filter((l, i, all) => l.trim() !== '' || all.slice(i).some((x) => x.trim() !== '')).map((l) => l.slice(10)).join('\n')
      : field('run');
    return { name: field('name'), run, uses: field('uses'), text };
  });
}

describe('release workflow', () => {
  const usesLines = (text: string) => text.split('\n').filter((l) => /^\s*(-\s+)?uses:/.test(l)).map((l) => l.trim());

  it('pins every action to a full commit SHA with a version comment, while ci keeps its tags', async () => {
    const release = usesLines(await read('.github/workflows/release.yml'));
    expect(release.length).toBeGreaterThanOrEqual(4);
    for (const line of release) expect(line).toMatch(/^(- )?uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    const ci = usesLines(await read('.github/workflows/ci.yml'));
    expect(ci.length).toBeGreaterThan(0);
    for (const line of ci) expect(line).toMatch(/^(- )?uses: [\w.-]+\/[\w.-]+@v\d+$/);
  });

  describe('the changelog check before publishing', () => {
    const dated = '# Changelog\n\n## 0.1.0 (2026-10-25)\n\n- One.\n\n## 0.0.9 (2026-01-01)\n\n- Older.\n';
    const cases: Array<[string, string, string, boolean]> = [
      ['a dated section', dated, 'v0.1.0', true],
      ['the last section of the file', '# Changelog\n\n## 0.1.0 (2026-10-25)\n\n- Only.\n', 'v0.1.0', true],
      ['a section still marked unreleased', '# Changelog\n\n## 0.1.0 (unreleased)\n\n- One.\n', 'v0.1.0', false],
      ['no section for the tag', dated, 'v0.2.0', false],
      ['a longer version that starts the same (0.10.0 is not 0.1.0)', '# Changelog\n\n## 0.10.0 (2026-10-25)\n\n- One.\n', 'v0.1.0', false],
      ['an empty file', '', 'v0.1.0', false],
    ];

    async function runScript(script: string, changelog: string, ref: string): Promise<{ code: number; output: string }> {
      await mkdir(path.join(tmp, 'runner'), { recursive: true });
      await writeFile(path.join(tmp, 'CHANGELOG.md'), changelog);
      try {
        const r = await run('bash', ['-e', '-c', script], { cwd: tmp, env: { PATH: process.env.PATH ?? '', GITHUB_REF_NAME: ref, RUNNER_TEMP: path.join(tmp, 'runner') } });
        return { code: 0, output: r.stdout + r.stderr };
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        return { code: err.code ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    }

    it('has a step in the publish job that runs before npm publish', async () => {
      const steps = jobSteps(await read('.github/workflows/release.yml'), 'publish');
      const check = steps.findIndex((s) => /changelog/i.test(s.name ?? '') && /CHANGELOG\.md/.test(s.run ?? '') && /\(unreleased\)/.test(s.run ?? ''));
      const publish = steps.findIndex((s) => /npm publish/.test(s.run ?? ''));
      expect(check, 'a CHANGELOG check step in the publish job').toBeGreaterThanOrEqual(0);
      expect(publish, 'the npm publish step').toBeGreaterThanOrEqual(0);
      expect(check).toBeLessThan(publish);
    });

    it.each(cases)('the publish job check gives the right verdict for %s', async (_what, changelog, ref, passes) => {
      const steps = jobSteps(await read('.github/workflows/release.yml'), 'publish');
      const check = steps.find((s) => /changelog/i.test(s.name ?? ''))!;
      const r = await runScript(check.run!, changelog, ref);
      expect(r.code === 0, r.output).toBe(passes);
      if (!passes) expect(r.output).toContain('::error file=CHANGELOG.md::');
    });

    it.each(cases)('the publish job check and the release notes step agree about %s', async (_what, changelog, ref) => {
      const workflow = await read('.github/workflows/release.yml');
      const check = jobSteps(workflow, 'publish').find((s) => /changelog/i.test(s.name ?? ''))!;
      const notes = stepScript(workflow, 'Extract release notes from CHANGELOG.md');
      const a = await runScript(check.run!, changelog, ref);
      const b = await runScript(notes, changelog, ref);
      expect(a.code === 0).toBe(b.code === 0);
      if (a.code !== 0) expect(a.output).toBe(b.output);
    });

    it('leaves the release job extracting the notes and passing them to gh release create', async () => {
      const steps = jobSteps(await read('.github/workflows/release.yml'), 'release');
      expect(steps.some((s) => s.name === 'Extract release notes from CHANGELOG.md')).toBe(true);
      expect(steps.some((s) => /gh release create .*--notes-file/.test(s.run ?? ''))).toBe(true);
    });
  });

  it('creates the GitHub release from the extracted notes file, not generated notes', async () => {
    const text = await read('.github/workflows/release.yml');
    expect(text).toMatch(/gh release create .*--notes-file/);
    expect(text).not.toContain('--generate-notes');
  });

  describe('the release notes step', () => {
    async function extract(changelog: string, ref: string): Promise<{ code: number; output: string; notes: string | null }> {
      const script = stepScript(await read('.github/workflows/release.yml'), 'Extract release notes from CHANGELOG.md');
      await mkdir(path.join(tmp, 'runner'), { recursive: true });
      await writeFile(path.join(tmp, 'CHANGELOG.md'), changelog);
      const env = { PATH: process.env.PATH ?? '', GITHUB_REF_NAME: ref, RUNNER_TEMP: path.join(tmp, 'runner') };
      let code = 0;
      let output = '';
      try {
        const r = await run('bash', ['-e', '-c', script], { cwd: tmp, env });
        output = r.stdout + r.stderr;
      } catch (e) {
        const err = e as { code?: number; stdout?: string; stderr?: string };
        code = err.code ?? 1;
        output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      }
      const notes = await readFile(path.join(tmp, 'runner', 'release-notes.md'), 'utf8').catch(() => null);
      return { code, output, notes };
    }

    const log = (section: string) => `# Changelog\n\n${section}\n## 0.0.9 (2026-01-01)\n\n- Older change.\n`;

    it('writes the dated section for the tag, without its heading or the next version', async () => {
      const r = await extract(log('## 0.1.0 (2026-10-25)\n\nFirst release.\n\n- One.\n- Two.\n'), 'v0.1.0');
      expect(r.code).toBe(0);
      expect(r.notes).toContain('First release.');
      expect(r.notes).toContain('- Two.');
      expect(r.notes).not.toContain('0.1.0');
      expect(r.notes).not.toContain('Older change');
    });

    it('reads the last section of the file too', async () => {
      const r = await extract('# Changelog\n\n## 0.1.0 (2026-10-25)\n\n- Only entry.\n', 'v0.1.0');
      expect(r.code).toBe(0);
      expect(r.notes?.trim()).toBe('- Only entry.');
    });

    it('fails with a clear message while the section still says unreleased', async () => {
      const r = await extract(log('## 0.1.0 (unreleased)\n\n- One.\n'), 'v0.1.0');
      expect(r.code).not.toBe(0);
      expect(r.output).toMatch(/CHANGELOG\.md.*0\.1\.0.*unreleased/);
    });

    it('fails with a clear message when there is no section for the tag, and does not mistake 0.10.0 for 0.1.0', async () => {
      const missing = await extract(log('## 0.2.0 (2026-10-25)\n\n- One.\n'), 'v0.1.0');
      expect(missing.code).not.toBe(0);
      expect(missing.output).toMatch(/CHANGELOG\.md.*no.*0\.1\.0/);
      const lookalike = await extract(log('## 0.10.0 (2026-10-25)\n\n- One.\n'), 'v0.1.0');
      expect(lookalike.code).not.toBe(0);
      expect(lookalike.notes).toBeNull();
    });
  });
});

describe('package.json', () => {
  it('points npm at the repository with a homepage and an issues link', async () => {
    const pkg = JSON.parse(await read('package.json')) as { homepage?: string; bugs?: { url?: string }; repository?: { url?: string } };
    expect(pkg.homepage).toBe('https://github.com/dededemahendra/whatsapp-agent#readme');
    expect(pkg.bugs).toEqual({ url: 'https://github.com/dededemahendra/whatsapp-agent/issues' });
    expect(pkg.repository?.url).toBe('git+https://github.com/dededemahendra/whatsapp-agent.git');
  });
});

describe('bin/whatsapp-agent.mjs', () => {
  /** Runs the shim as if Node reported this version. The preload only changes what process.versions.node says. */
  async function shim(nodeVersion: string): Promise<{ code: number; stderr: string }> {
    const preload = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(nodeVersion)} });`)}`;
    try {
      const r = await run(process.execPath, ['--import', preload, path.join(ROOT, 'bin', 'whatsapp-agent.mjs'), '--version']);
      return { code: 0, stderr: r.stderr };
    } catch (e) {
      const err = e as { code?: number; stderr?: string };
      return { code: err.code ?? 1, stderr: err.stderr ?? '' };
    }
  }

  it('refuses to start on a Node older than 22.12.0, saying so and which version it found', async () => {
    for (const v of ['22.11.9', '22.0.0', '21.7.3', '20.19.0', '18.20.4', '4.9.1']) {
      expect(await shim(v)).toEqual({ code: 1, stderr: `whatsapp-agent needs Node 22.12 or newer (found ${v}).\n` });
    }
  });

  it('does not refuse Node 22.12.0 or newer', async () => {
    for (const v of ['22.12.0', '22.12.1', '22.13.0', '23.0.0', '24.1.0', '26.10.0']) {
      expect((await shim(v)).stderr, v).not.toContain('needs Node');
    }
  });
});

describe('README', () => {
  /** Line breaks and runs of spaces do not matter to a reader, so they do not matter here. */
  const flat = (text: string): string => text.replace(/\s+/g, ' ');

  it('says an attempted row is written before every write, not only before a send', async () => {
    const readme = flat(await read('README.md'));
    expect(readme).toContain('An `attempted` row is written before every write (a send, a reaction or a mark as read)');
    expect(readme).toContain('If the `attempted` row cannot be written, the write is not made.');
    expect(readme).not.toContain('A send is preceded by an `attempted` row');
    expect(readme).toContain('A confirmation prompt that is never answered leaves no row.');
  });

  it('says in the WHATSAPP_AGENT_LOG row that debug lines need that level and that a lost sent row always warns', async () => {
    const readme = await read('README.md');
    const row = readme.split('\n').find((l) => l.startsWith('| `WHATSAPP_AGENT_LOG` |'));
    expect(row, 'the WHATSAPP_AGENT_LOG row').toBeDefined();
    expect(flat(row!)).toContain('Debug lines print only at that level, and one warning line is printed on stderr whenever a sent row cannot be written to the audit log, at any level.');
    expect(row).toContain('never message text');
    expect(row!.match(/\|/g)).toHaveLength(3); // still a two-cell table row
  });

  it('says a confirmation has to be answered within five minutes', async () => {
    expect(flat(await read('README.md'))).toContain('A confirmation must be answered within five minutes. After that the host reports an error and the agent has to ask again.');
  });
});

describe('design spec', () => {
  const flat = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const SPEC = 'docs/superpowers/specs/2026-10-20-whatsapp-agent-design.md';

  const A27 = 'A27. Confirmation answers are bound to the request. The server mints a signed `requestState` for every confirmation prompt with the MCP SDK\'s request-state codec (a random per-process key, 300 second lifetime). Its payload names the kind of write, the resolved JID, the chat kind, a random nonce and a SHA-256 digest of every field that affects the send. An answer counts as acceptance only when the state verifies, its digest equals one recomputed from the current call, and its nonce has not been used before; anything else is no answer and the person is asked again. A state the SDK cannot verify, or one that has expired, is refused before the handler runs and nothing is sent. On the 2025 protocol the prompt is an elicitation answered in process and no state travels.';
  const A28 = 'A28. A failure after the write has been handed to wacli is reported as SEND_UNCERTAIN with `outcome_uncertain` true, and the audit row carries `uncertain` true with the reason suffixed "(outcome uncertain, may have been delivered)". Errors raised before the spawn or by wacli\'s flag parsing, and wacli\'s own definite verdicts (not paired, store locked, not found, too old), are reported as they are, because nothing was sent. A `sent` row that cannot be written is logged and the send is still reported as sent; the `attempted` row (A24) stays fail-closed.';
  const A29 = 'A29. The MCP server serves both protocol eras through the SDK\'s `serveStdio`. On SIGINT, SIGTERM or SIGHUP it closes the transport and waits for writes in flight (from the policy gate to the audit append) within one 10 second budget, then exits 0; a second signal exits 130.';
  const A30 = 'A30. A declined confirmation denies the write even when the policy no longer calls for a prompt (confirm set to never, or the recipient allowlisted since the prompt). A decline never sends.';

  it('ends section 16 with amendments A27 to A30, in order, after A26', async () => {
    const spec = await read(SPEC);
    const bullets = spec.slice(spec.indexOf('## 16. Amendments')).split(/\n(?=- A\d+\. )/).slice(1);
    const numbers = bullets.map((b) => /^- (A\d+)\./.exec(b)![1]);
    expect(numbers.slice(-5)).toEqual(['A26', 'A27', 'A28', 'A29', 'A30']);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(flat(bullets.at(-4)!)).toBe(`- ${A27}`);
    expect(flat(bullets.at(-3)!)).toBe(`- ${A28}`);
    expect(flat(bullets.at(-2)!)).toBe(`- ${A29}`);
    expect(flat(bullets.at(-1)!)).toBe(`- ${A30}`);
  });

  it('wraps the new amendments like the ones before them: a dash, two spaces of indent, 80 columns', async () => {
    const spec = await read(SPEC);
    const tail = spec.slice(spec.indexOf('- A27. ')).split('\n').filter((l) => l !== '');
    expect(tail.length).toBeGreaterThan(10);
    for (const line of tail) {
      expect(line.length, line).toBeLessThanOrEqual(80);
      expect(line.startsWith('- A') || line.startsWith('  '), line).toBe(true);
    }
    expect(spec.endsWith('\n')).toBe(true);
    expect(spec.endsWith('\n\n')).toBe(false);
  });

  it('no longer says in section 5 that no requestState is used, and points at A27 instead', async () => {
    const spec = await read(SPEC);
    expect(spec).not.toContain('No `requestState` is used in v1');
    const section5 = spec.slice(spec.indexOf('### Confirmation flow'), spec.indexOf('## 6. Policy'));
    expect(flat(section5)).toContain('A signed `requestState` binds each answer to its prompt (A27).');
    expect(section5).not.toContain('a single round suffices');
  });

  it('points the decline step of the decision algorithm at A30 in one added sentence', async () => {
    const spec = await read(SPEC);
    const algorithm = spec.slice(spec.indexOf('### Decision algorithm'), spec.indexOf('### Rate-limit state'));
    const step10 = algorithm.slice(algorithm.indexOf('10. If needed'), algorithm.indexOf('11. '));
    expect(flat(step10)).toBe('10. If needed and the answer is declined, cancelled or unticked: `Deny(confirmation_declined)`. A declined answer denies even when the policy no longer needs a confirmation (A30).');
    expect(algorithm.match(/A30/g)).toHaveLength(1);
  });

  it('changes nothing else in sections 1 to 15 of the spec that A27 to A30 do not replace', async () => {
    const spec = await read(SPEC);
    expect(spec).toContain('The SDK\'s legacy shim serves pre-2026 clients that do');
    expect(spec).toContain('- A26. `daemon.staleThreshold` is at most 2 minutes (seconds up to 120, or `1m`');
  });
});
