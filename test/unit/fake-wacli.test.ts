import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_WACLI, fakeEnv, makeTmp, readArgvLog, removeTmp } from '../helpers/fake.js';

const run = promisify(execFile);
let tmp: string;
beforeEach(async () => { tmp = await makeTmp(); });
afterEach(async () => { await removeTmp(tmp); });

describe('fake wacli', () => {
  it('answers chats list with the fixture envelope and logs argv', async () => {
    const log = path.join(tmp, 'argv.log');
    const { stdout } = await run(FAKE_WACLI, ['--json', '--read-only', 'chats', 'list', '--limit=5'], { env: fakeEnv({ FAKE_WACLI_LOG: log, WACLI_READONLY: '1' }) });
    const env = JSON.parse(stdout);
    expect(env.success).toBe(true);
    expect(env.data).toHaveLength(2);
    const [rec] = await readArgvLog(log);
    expect(rec!.key).toBe('chats list');
    expect(rec!.argv).toEqual(['--json', '--read-only', 'chats', 'list', '--limit=5']);
    expect(rec!.env.WACLI_READONLY).toBe('1');
  });

  it('writes a JSON error envelope to stderr and exits with the code on FAIL', async () => {
    await expect(run(FAKE_WACLI, ['--json', 'send', 'text', '--to=x'], { env: fakeEnv({ FAKE_WACLI_FAIL: 'send text|1|not authenticated; run `wacli auth`' }) }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('"success":false') });
  });

  it('answers an empty key with data null, as wacli encodes an empty list', async () => {
    const env = fakeEnv({ FAKE_WACLI_EMPTY: 'chats list,contacts search' });
    for (const args of [['chats', 'list'], ['contacts', 'search', '--', 'a']]) {
      const { stdout } = await run(FAKE_WACLI, ['--json', '--read-only', ...args], { env });
      expect(JSON.parse(stdout)).toEqual({ success: true, data: null, error: null });
    }
  });

  it('answers an empty message page with the usual wrapper and messages null', async () => {
    const env = fakeEnv({ FAKE_WACLI_EMPTY: 'messages list,messages search,messages context' });
    for (const args of [['messages', 'list', '--chat=x'], ['messages', 'search', '--', 'q']]) {
      const { stdout } = await run(FAKE_WACLI, ['--json', '--read-only', ...args], { env });
      expect(JSON.parse(stdout)).toMatchObject({ success: true, data: { messages: null, fts: true, page: { has_more: false, next_cursor: null } }, error: null });
    }
    const { stdout } = await run(FAKE_WACLI, ['--json', '--read-only', 'messages', 'context', '--chat=x', '--id=MSG1'], { env });
    const data = JSON.parse(stdout).data;
    expect(data.messages).toBeNull();
    expect(data).toMatchObject({ chat_jid: expect.any(String), msg_id: expect.any(String) });
    expect(data).not.toHaveProperty('page');
  });

  it('prints a plain version', async () => {
    const { stdout } = await run(FAKE_WACLI, ['version'], { env: fakeEnv() });
    expect(stdout.trim()).toBe('0.22.0');
  });

  it('exits 2 for an unknown command', async () => {
    await expect(run(FAKE_WACLI, ['--json', 'profile', 'show'], { env: fakeEnv() })).rejects.toMatchObject({ code: 2 });
  });

  it('writes a PNG for media download into a directory', async () => {
    const { stdout } = await run(FAKE_WACLI, ['--json', '--read-only', 'media', 'download', '--chat=61400000001@s.whatsapp.net', '--id=MSG3', `--output=${tmp}`], { env: fakeEnv() });
    const env = JSON.parse(stdout);
    expect(env.data.path).toBe(path.join(tmp, 'MSG3.png'));
    expect(env.data.bytes).toBe(70);
  });
});
