import { readFileSync } from 'node:fs';

export const MIN_WACLI_VERSION = '0.22.0';

function readPackageVersion(): string {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  return (JSON.parse(raw) as { version: string }).version;
}

export const PKG_VERSION: string = readPackageVersion();

export function parseVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function meetsMinimum(v: string | null): boolean {
  return v !== null && compareVersions(v, MIN_WACLI_VERSION) >= 0;
}
