import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Architectural regression: nothing outside the runtime integration layer may
 * depend on AMP-specific APIs, ampinstmgr, or AMP types. This keeps the product
 * usable without AMP and lets future adapters (systemd/docker) slot in cleanly.
 */
const SRC = path.join(__dirname, '../src');

// Only these paths are permitted to reference AMP internals.
const ALLOWED = ['integrations/amp/', 'integrations/runtime/'];

// AMP-specific coupling markers (NOT the neutral AMP_UNAVAILABLE error code or
// the AMP_PASSWORD log-redaction key, which are cross-cutting).
const COUPLING = /(from ['"].*integrations\/amp|ampinstmgr|\bInstanceStatus\b|\bInstanceState\b)/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('no AMP coupling outside the runtime integration layer', () => {
  it('has zero AMP-specific imports/types in business or shared modules', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, '/');
      if (ALLOWED.some((p) => rel.startsWith(p))) continue;
      if (COUPLING.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('modules go through the runtime abstraction, not the amp service', () => {
    for (const f of ['modules/server/service.ts', 'modules/server/lifecycle.ts', 'modules/system/routes.ts']) {
      const text = fs.readFileSync(path.join(SRC, f), 'utf8');
      expect(text).toContain("integrations/runtime");
      expect(text).not.toContain('integrations/amp');
    }
  });
});
