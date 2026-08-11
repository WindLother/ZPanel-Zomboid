import { describe, it, expect } from 'vitest';
import { enumToLabel, labelToEnum } from '../src/modules/sandbox/mapping';
import { roleToFrontendLevel, frontendLevelToRconArg } from '../src/modules/players/access';
import { operationLock } from '../src/shared/lock';

describe('sandbox enum mapping', () => {
  const SPEED = ['Sprinters', 'Fast Shamblers', 'Shamblers', 'Random'] as const;
  it('maps raw value -> label (1-based)', () => {
    expect(enumToLabel(SPEED, 1)).toBe('Sprinters');
    expect(enumToLabel(SPEED, 4)).toBe('Random');
  });
  it('maps label -> raw value', () => {
    expect(labelToEnum(SPEED, 'Shamblers')).toBe(3);
  });
  it('rejects unknown labels', () => {
    expect(() => labelToEnum(SPEED, 'Nope')).toThrow();
  });
});

describe('access level mapping (Build 42 roles)', () => {
  it('maps PZ roles to frontend labels', () => {
    expect(roleToFrontendLevel('admin')).toBe('Admin');
    expect(roleToFrontendLevel('moderator')).toBe('Moderator');
    expect(roleToFrontendLevel('user')).toBe('Player');
    expect(roleToFrontendLevel('observer')).toBe('Observer');
    expect(roleToFrontendLevel(null)).toBe('Player');
  });
  it('maps frontend labels to RCON args and rejects arbitrary strings', () => {
    expect(frontendLevelToRconArg('Admin')).toBe('Admin');
    expect(frontendLevelToRconArg('Player')).toBe('none');
    expect(() => frontendLevelToRconArg('SuperAdmin')).toThrow();
    expect(() => frontendLevelToRconArg('admin"; rm -rf')).toThrow();
  });
});

describe('operation lock', () => {
  it('serializes and rejects conflicting operations', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const first = operationLock.run('restart', 'a', async () => {
      await gate;
      return 'done';
    });
    await expect(operationLock.run('stop', 'b', async () => 'x')).rejects.toMatchObject({
      code: 'OPERATION_IN_PROGRESS',
    });
    release();
    await expect(first).resolves.toBe('done');
    // Lock is released afterwards.
    await expect(operationLock.run('start', 'c', async () => 'ok')).resolves.toBe('ok');
  });
});

