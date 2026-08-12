import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseXmxBytes, configuredHeapBytes } from '../src/integrations/zomboid-files/jvm-config';

const GiB = 1024 ** 3;
const TMP = '/tmp/zpanel-test/jvm-config';

/**
 * Regression coverage for the dashboard memory-limit source: the configured
 * heap must come from an authoritative JVM source (cmdline -Xmx or
 * ProjectZomboid64.json) — never from a hardcoded production fallback.
 */
describe('parseXmxBytes: JVM -Xmx representations', () => {
  it('parses megabyte forms', () => {
    expect(parseXmxBytes('-Xmx3072m')).toBe(3 * GiB);
    expect(parseXmxBytes('-Xmx10240m')).toBe(10 * GiB);
  });
  it('parses gigabyte forms (8/10/12 GB) case-insensitively', () => {
    expect(parseXmxBytes('-Xmx8g')).toBe(8 * GiB);
    expect(parseXmxBytes('-Xmx10G')).toBe(10 * GiB);
    expect(parseXmxBytes('-Xmx12g')).toBe(12 * GiB);
    expect(parseXmxBytes('-XMX12G')).toBe(12 * GiB);
  });
  it('parses kilobyte and plain-byte forms', () => {
    expect(parseXmxBytes('-Xmx1048576k')).toBe(1 * GiB);
    expect(parseXmxBytes(`-Xmx${2 * GiB}`)).toBe(2 * GiB);
  });
  it('returns null for non-Xmx args and malformed values (no fabrication)', () => {
    for (const bad of ['-Xms3072m', '-XX:+UseZGC', '-Xmx', '-Xmxlots', '', 'Xmx4g', '-Xmx0m', '-Xmx-5g']) {
      expect(parseXmxBytes(bad), bad).toBeNull();
    }
  });
});

describe('configuredHeapBytes: ProjectZomboid64.json as authoritative source', () => {
  beforeAll(() => fs.mkdirSync(TMP, { recursive: true }));
  afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));
  const write = (name: string, content: unknown): string => {
    const f = path.join(TMP, name);
    fs.writeFileSync(f, typeof content === 'string' ? content : JSON.stringify(content));
    return f;
  };

  it('reads the -Xmx from vmArgs (real Build 42 launcher shape)', () => {
    const f = write('pz64.json', {
      mainClass: 'zombie/network/GameServer',
      classpath: ['java/.', 'java/projectzomboid.jar'],
      vmArgs: ['-Djava.awt.headless=true', '-Xmx3072m', '-XX:+UseZGC'],
    });
    expect(configuredHeapBytes(f)).toBe(3 * GiB);
  });

  it('last -Xmx wins (JVM semantics for repeated flags)', () => {
    const f = write('dup.json', { vmArgs: ['-Xmx4096m', '-Xmx12g'] });
    expect(configuredHeapBytes(f)).toBe(12 * GiB);
  });

  it('returns null (never a guess) for missing file / no vmArgs / no -Xmx / bad JSON', () => {
    expect(configuredHeapBytes(path.join(TMP, 'nope.json'))).toBeNull();
    expect(configuredHeapBytes(write('novm.json', { mainClass: 'x' }))).toBeNull();
    expect(configuredHeapBytes(write('noxmx.json', { vmArgs: ['-XX:+UseZGC'] }))).toBeNull();
    expect(configuredHeapBytes(write('bad.json', '{not json'))).toBeNull();
  });
});

describe('no hardcoded memory-limit fallback in the overview path', () => {
  const service = fs.readFileSync(path.join(__dirname, '..', 'src/modules/server/service.ts'), 'utf8');

  it('server overview derives memoryLimit from runtime metrics, with no numeric fallback', () => {
    // The old production bug: `toGB(metrics.memoryLimitBytes) || 4`.
    expect(service).not.toMatch(/memoryLimitBytes\)\s*\|\|\s*\d/);
    expect(service).not.toMatch(/memLimit\s*=[^\n]*\|\|\s*\d/);
    // Honest null when the limit is unknown.
    expect(service).toMatch(/memoryLimitBytes \? toGB\(metrics\.memoryLimitBytes\) : null/);
  });

  it('memory usage and heap ceiling come from separate sources (usage is never Xmx)', () => {
    const proc = fs.readFileSync(path.join(__dirname, '..', 'src/integrations/os/proc.ts'), 'utf8');
    // usage: PSS/VmRSS; ceiling: cmdline -Xmx -> ProjectZomboid64.json
    expect(proc).toMatch(/Pss/);
    expect(proc).toMatch(/VmRSS/);
    expect(proc).toMatch(/configuredHeapBytes\(\)/);
    // memoryBytes must never be assigned from the xmx helper
    expect(proc).not.toMatch(/memoryBytes\s*=\s*(await\s+)?xmxLimitBytes/);
  });
});
