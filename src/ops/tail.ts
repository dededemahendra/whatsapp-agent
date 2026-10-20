import { readFile, stat } from 'node:fs/promises';

export async function tailFile(file: string, lines: number): Promise<string> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return '';
  }
  const all = text.split('\n');
  if (all[all.length - 1] === '') all.pop();
  return all.slice(Math.max(0, all.length - lines)).map((l) => l + '\n').join('');
}

/** Print bytes appended after the call, polling every `intervalMs`, until the returned function is called. */
export function followFile(file: string, write: (chunk: string) => void, intervalMs = 1000): () => void {
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
    } catch {
      // file may not exist yet
    }
  };
  void poll();
  const timer = setInterval(() => { void poll(); }, intervalMs);
  return () => clearInterval(timer);
}
