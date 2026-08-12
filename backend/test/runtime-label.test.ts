import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { AmpRuntimeAdapter } from '../src/integrations/runtime/amp.adapter';
import { SystemdRuntimeAdapter } from '../src/integrations/runtime/systemd.adapter';
import { StandaloneRuntimeAdapter } from '../src/integrations/runtime/standalone.adapter';

/**
 * Regression guard for the stale "AMP + RCON" dashboard badge: the runtime
 * label shown to users must derive from the backend's runtime capabilities,
 * never from a hardcoded AMP string — while AMP remains a fully supported
 * adapter for deployments that use it.
 */
const FRONTEND = fs.readFileSync(path.join(__dirname, '..', '..', 'Zomboid_Server_Control.dc.html'), 'utf8');
const SERVICE = fs.readFileSync(path.join(__dirname, '..', 'src/modules/server/service.ts'), 'utf8');

describe('runtime name flows from adapter capabilities to the overview', () => {
  it('each adapter reports its own runtime name (AMP support intact)', () => {
    expect(new SystemdRuntimeAdapter().capabilities().runtime).toBe('systemd');
    expect(new AmpRuntimeAdapter().capabilities().runtime).toBe('amp');
    expect(new StandaloneRuntimeAdapter().capabilities().runtime).toBe('standalone');
  });

  it('the server overview exposes the runtime name for the frontend badge', () => {
    expect(SERVICE).toMatch(/runtime:\s*runtime\.capabilities\(\)\.runtime/);
  });
});

describe('frontend runtime badge is dynamic — no stale AMP labels', () => {
  it('no hardcoded "AMP + RCON" / "AMP PROCESS" badge remains', () => {
    expect(FRONTEND).not.toContain('"AMP + RCON"');
    expect(FRONTEND).not.toContain('"AMP PROCESS"');
    expect(FRONTEND).not.toContain('AMP · RCON · FILES');
  });

  it('the badge derives from the backend-provided runtime name', () => {
    expect(FRONTEND).toMatch(/srvRaw\.runtime/);
    expect(FRONTEND).toMatch(/rtName \+ " \+ RCON"/);
    expect(FRONTEND).toMatch(/rtName \+ " PROCESS"/);
  });

  it('no user-facing AMP wording remains anywhere in the page', () => {
    // Whole-page sweep: the only allowed AMP mentions would be code identifiers,
    // and none exist in the frontend today. Keep it that way.
    expect(FRONTEND).not.toMatch(/\bAMP\b/);
  });

  it('no hardcoded memory-limit fallback in frontend presentation logic', () => {
    expect(FRONTEND).not.toMatch(/memoryLimit:\s*(4|8|10|12)\b/);
    // limit rendering is null-safe instead of assuming a number
    expect(FRONTEND).toMatch(/memLimit != null/);
    expect(FRONTEND).toMatch(/limit unknown/);
  });
});
