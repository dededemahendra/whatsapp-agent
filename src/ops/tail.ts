import { readFile, stat } from 'node:fs/promises';

/** The last `lines` lines of a file, or null when the file does not exist yet (other read errors give an empty string). */
export async function tailFile(file: string, lines: number): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : '';
  }
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  return all.slice(Math.max(0, all.length - lines)).map((l) => l + '\n').join('');
}

/**
 * Print bytes appended after the call, polling every `intervalMs`, until the returned function is called.
 * A file that does not exist yet is shown from its beginning once it appears. `ready` settles after the first poll.
 */
export function followFile(file: string, write: (chunk: string) => void, intervalMs = 1000): (() => void) & { ready: Promise<void> } {
  let offset = -1;
  const poll = async (): Promise<void> => {
    try {
      const size = (await stat(file)).size;
      if (offset < 0 || size < offset) offset = size;
      if (size > offset) {
        const bytes = await readFile(file);
        write(bytes.subarray(offset, size).toString('utf8'));
        offset = size;
      }
    } catch (e) {
      if (offset < 0 && (e as NodeJS.ErrnoException).code === 'ENOENT') offset = 0;
    }
  };
  const ready = poll();
  const timer = setInterval(() => { void poll(); }, intervalMs);
  return Object.assign(() => clearInterval(timer), { ready });
}
