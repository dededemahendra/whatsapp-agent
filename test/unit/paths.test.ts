import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ensurePrivateDir, resolvePaths } from '../../src/paths.js';

const tmps: string[] = [];
afterEach(async () => { for (const t of tmps.splice(0)) await rm(t, { recursive: true, force: true }); });

describe('resolvePaths', () => {
  it('defaults under ~/.config and ~/.local/share', () => {
    const p = resolvePaths({}, '/home/u');
    expect(p.configDir).toBe('/home/u/.config/whatsapp-agent');
    expect(p.dataDir).toBe('/home/u/.local/share/whatsapp-agent');
    expect(p.mediaDir).toBe('/home/u/.local/share/whatsapp-agent/media');
    expect(p.policyFile).toBe('/home/u/.config/whatsapp-agent/policy.json');
    expect(p.auditFile).toBe('/home/u/.local/share/whatsapp-agent/audit.jsonl');
    expect(p.rateLimitFile).toBe('/home/u/.local/share/whatsapp-agent/rate-limit.json');
    expect(p.daemonLog).toBe('/home/u/.local/share/whatsapp-agent/daemon.log');
  });

  it('honours XDG variables', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: '/x/cfg', XDG_DATA_HOME: '/x/data' }, '/home/u');
    expect(p.configDir).toBe('/x/cfg/whatsapp-agent');
    expect(p.dataDir).toBe('/x/data/whatsapp-agent');
  });

  it('honours explicit overrides over XDG', () => {
    const p = resolvePaths({ XDG_CONFIG_HOME: '/x/cfg', WHATSAPP_AGENT_CONFIG_DIR: '/o/cfg', WHATSAPP_AGENT_DATA_DIR: '/o/data' }, '/home/u');
    expect(p.configDir).toBe('/o/cfg');
    expect(p.dataDir).toBe('/o/data');
  });
});

describe('ensurePrivateDir', () => {
  it('creates nested directories with mode 0700', async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), 'wa-paths-'));
    tmps.push(base);
    const dir = path.join(base, 'a', 'b');
    await ensurePrivateDir(dir);
    const s = await stat(dir);
    expect(s.isDirectory()).toBe(true);
    expect(s.mode & 0o777).toBe(0o700);
  });
});
