import { describe, expect, it } from 'vitest';
import { createRunner } from '../../src/wacli/runner.js';
import type { WacliChat, WacliDoctor } from '../../src/wacli/shape.js';
import { getStatus } from '../../src/wacli/status.js';

const enabled = process.env.WHATSAPP_AGENT_SMOKE === '1';

describe.skipIf(!enabled)('real wacli (read-only)', () => {
  const runner = createRunner({ bin: process.env.WHATSAPP_AGENT_WACLI_BIN || 'wacli' });

  it('reports a paired store that meets the minimum version', async () => {
    const s = await getStatus(runner, new Date());
    expect(s.min_version_ok).toBe(true);
    expect(s.authenticated).toBe(true);
  });

  it('lists a few chats without writing anything', async () => {
    const doctor = await runner.read<WacliDoctor>(['doctor']);
    expect(doctor.store_dir).toBeTruthy();
    const chats = await runner.read<WacliChat[]>(['chats', 'list', '--limit=3']);
    expect(chats === null || Array.isArray(chats)).toBe(true);
  });
});
