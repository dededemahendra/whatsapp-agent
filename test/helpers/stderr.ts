import { vi } from 'vitest';

/** Collects what the code under test writes to stderr, and keeps it out of the test run's own output. `vi.restoreAllMocks()` puts stderr back. */
export function captureStderr(): { text(): string; lines(): string[] } {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  const text = (): string => spy.mock.calls.map((c) => String(c[0])).join('');
  return { text, lines: () => text().split('\n').filter((l) => l !== '') };
}
