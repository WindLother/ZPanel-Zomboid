import { describe, it, expect } from 'vitest';
import { enumToLabel, labelToEnum } from '../src/modules/sandbox/mapping';
import { roleToFrontendLevel, frontendLevelToRconArg } from '../src/modules/players/access';
import { operationLock } from '../src/shared/lock';

describe('sandbox enum mapping', () => {
  // Explicit {value,label} pairs (as generated from PZ's own legend comments) —
  // never an index-position assumption.
  const SPEED = [
    { value: 1, label: 'Sprinters' },
    { value: 2, label: 'Fast Shamblers' },
    { value: 3, label: 'Shamblers' },
    { value: 4, label: 'Random' },
  ] as const;
  it('maps raw value -> label', () => {
    expect(enumToLabel(SPEED, 1)).toBe('Sprinters');
    expect(enumToLabel(SPEED, 4)).toBe('Random');
  });
  it('maps label -> raw value', () => {
    expect(labelToEnum(SPEED, 'Shamblers')).toBe(3);
  });
  it('rejects unknown labels', () => {
    expect(() => labelToEnum(SPEED, 'Nope')).toThrow();
  });
  it('honours non-contiguous enum values instead of assuming index+1', () => {
    const SPARSE = [
      { value: 2, label: 'Zombies only' },
      { value: 3, label: 'All types of target' },
    ] as const;
    expect(enumToLabel(SPARSE, 2)).toBe('Zombies only');
    expect(labelToEnum(SPARSE, 'All types of target')).toBe(3);
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

