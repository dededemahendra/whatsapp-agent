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

/** Print appended bytes every second until the returned function is called. */
export function followFile(file: string, write: (chunk: string) => void): () => void {
  let offset = 0;
  const timer = setInterval(async () => {
    try {
      const size = (await stat(file)).size;
      if (size < offset) offset = 0;
      if (size > offset) {
        const text = await readFile(file, 'utf8');
        write(text.slice(offset));
        offset = size;
      }
    } catch {
      // file may not exist yet
    }
  }, 1000);
  return () => clearInterval(timer);
}
