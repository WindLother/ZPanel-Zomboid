import { describe, it, expect } from 'vitest';
import { parsePlayers, parseSaveResult, parseHelp, parseCheckModsAck } from '../src/integrations/rcon/parsers';

describe('parsePlayers', () => {
  it('parses zero players (real server fixture)', () => {
    // Captured verbatim from the live server.
    expect(parsePlayers('Players connected (0): \n')).toEqual({ count: 0, usernames: [] });
  });

  it('parses one player', () => {
    expect(parsePlayers('Players connected (1): \nAlice\n')).toEqual({ count: 1, usernames: ['Alice'] });
  });

  it('parses multiple players (newline separated)', () => {
    const r = parsePlayers('Players connected (3): \nAlice\nBob_2\ndsl.ghost\n');
    expect(r.count).toBe(3);
    expect(r.usernames).toEqual(['Alice', 'Bob_2', 'dsl.ghost']);
  });

  it('handles bullet/dash-prefixed name lists', () => {
    const r = parsePlayers('Players connected (2):\n-Alice\n-Bob\n');
    expect(r.usernames).toEqual(['Alice', 'Bob']);
  });

  it('tolerates unexpected whitespace and CRLF', () => {
    const r = parsePlayers('  Players connected (2):  \r\n   Alice  \r\n  Bob \r\n');
    expect(r.count).toBe(2);
    expect(r.usernames).toEqual(['Alice', 'Bob']);
  });

  it('handles special characters in usernames', () => {
    const r = parsePlayers('Players connected (2): \nMarta_K\ntomate99\n');
    expect(r.usernames).toEqual(['Marta_K', 'tomate99']);
  });

  it('falls back to counting names when header count is absent', () => {
    const r = parsePlayers('Alice\nBob\n');
    expect(r.count).toBe(2);
  });
});

describe('parseSaveResult', () => {
  it('treats "World saved" as success', () => {
    expect(parseSaveResult('World saved')).toEqual({ ok: true, message: 'World saved' });
  });
  it('detects failure keywords', () => {
    expect(parseSaveResult('Error: could not save').ok).toBe(false);
  });
  it('treats empty response as success', () => {
    expect(parseSaveResult('').ok).toBe(true);
  });
});

describe('parseHelp', () => {
  it('extracts command names and descriptions', () => {
    const raw = 'List of server commands : \n* players : List all connected players\n* save : Save the current world\n';
    const cmds = parseHelp(raw);
    expect(cmds).toContainEqual({ name: 'players', description: 'List all connected players' });
    expect(cmds).toContainEqual({ name: 'save', description: 'Save the current world' });
  });
});

describe('parseCheckModsAck', () => {
  it('accepts a normal acknowledgement', () => {
    expect(parseCheckModsAck('Checking mods...').accepted).toBe(true);
  });
  it('rejects unknown command', () => {
    expect(parseCheckModsAck('Unknown command "x"').accepted).toBe(false);
  });
});
