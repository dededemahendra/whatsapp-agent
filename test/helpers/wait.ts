/** Polls `condition` until it is true, failing with `what` once the deadline passes. Use it in place of a fixed sleep. */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs = 8000, intervalMs = 10, what = 'the condition' }: { timeoutMs?: number; intervalMs?: number; what?: string } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
