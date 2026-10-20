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
