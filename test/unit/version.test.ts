import { describe, expect, it } from 'vitest';
import { compareVersions, meetsMinimum, MIN_WACLI_VERSION, parseVersion, PKG_VERSION } from '../../src/version.js';

describe('version', () => {
  it('exposes the package version', () => {
    expect(PKG_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('parses a bare version and a prefixed version', () => {
    expect(parseVersion('0.22.0')).toBe('0.22.0');
    expect(parseVersion('wacli v0.23.1 (darwin/arm64)\n')).toBe('0.23.1');
    expect(parseVersion('dev')).toBeNull();
  });

  it('compares versions numerically', () => {
    expect(compareVersions('0.22.0', '0.22.0')).toBe(0);
    expect(compareVersions('0.9.9', '0.22.0')).toBeLessThan(0);
    expect(compareVersions('1.0.0', '0.22.0')).toBeGreaterThan(0);
  });

  it('compares the patch component', () => {
    expect(compareVersions('0.22.1', '0.22.0')).toBeGreaterThan(0);
    expect(compareVersions('0.22.0', '0.22.1')).toBeLessThan(0);
    expect(compareVersions('0.22.10', '0.22.9')).toBeGreaterThan(0);
  });

  it('accepts versions above the minimum in the patch, minor and major position', () => {
    expect(meetsMinimum('0.22.1')).toBe(true);
    expect(meetsMinimum('0.23.0')).toBe(true);
    expect(meetsMinimum('1.0.0')).toBe(true);
  });

  it('reads a pre-release tag as its release, because parseVersion keeps only the three numbers', () => {
    expect(parseVersion('0.22.0-rc1')).toBe('0.22.0');
    expect(meetsMinimum(parseVersion('0.22.0-rc1'))).toBe(true);
    expect(meetsMinimum(parseVersion('0.21.9-rc1'))).toBe(false);
  });

  it('checks the minimum', () => {
    expect(MIN_WACLI_VERSION).toBe('0.22.0');
    expect(meetsMinimum('0.22.0')).toBe(true);
    expect(meetsMinimum('0.21.9')).toBe(false);
    expect(meetsMinimum(null)).toBe(false);
  });
});
