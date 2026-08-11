import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guard for the "Users & Access → Add User opened the WHITELIST modal"
 * production bug. Root cause: two class fields both named `openAddUser` — the
 * whitelist one (defined later) SHADOWED the panel-user one, so both the panel
 * button and the whitelist button resolved to the whitelist dialog.
 *
 * The frontend is a compiled DC-runtime template (no DOM test runner here), so we
 * assert the wiring at the source level: distinct handlers, distinct dialogs,
 * distinct APIs, and no accidental collision reappearing.
 */
const FRONTEND = path.join(__dirname, '..', '..', 'Zomboid_Server_Control.dc.html');
const html = fs.readFileSync(FRONTEND, 'utf8');

/** Slice the source between two anchors so we can assert on one handler in isolation. */
function between(start: string, end: string): string {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  expect(a, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `anchor not found: ${end}`).toBeGreaterThan(a);
  return html.slice(a, b);
}

describe('panel-user Add User is fully separated from the whitelist dialog', () => {
  it('the two handlers are named differently — no class-field shadowing', () => {
    // Exactly one definition of each. If a future edit re-collides the names, the
    // later one silently shadows the earlier and this count breaks.
    expect((html.match(/openAddUser = \(\) =>/g) || []).length).toBe(1);
    expect((html.match(/openAddWhitelistUser = \(\) =>/g) || []).length).toBe(1);
  });

  it('the PANEL USERS "Add User" button opens the panel-user handler', () => {
    const section = between('PANEL USERS', 'USERNAME'); // header block of the users table
    expect(section).toContain('actions.openAddUser');
    expect(section).not.toContain('openAddWhitelistUser');
  });

  it('the WHITELIST "Add User" button opens the whitelist handler', () => {
    const section = between('WHITELISTED USERS', 'STEAM IDS');
    expect(section).toContain('actions.openAddWhitelistUser');
    // must NOT resolve to the panel-user handler
    expect(section).not.toMatch(/actions\.openAddUser\b/);
  });

  it('panel-user dialog uses usersApi.create and NEVER the whitelist API', () => {
    const handler = between('openAddUser = () =>', 'userMenuItems(u)');
    expect(handler).toContain('kicker: "PANEL USER"');
    expect(handler).toContain('title: "Add Panel User"');
    expect(handler).toContain('usersApi.create');
    // sends username + password + role, and validates confirm
    expect(handler).toMatch(/usersApi\.create\(\{\s*username,\s*password:[^}]*role\s*\}\)/);
    expect(handler).toContain('showPassword: true');
    expect(handler).toContain('showConfirm: true');
    expect(handler).toContain('showSelect: true');
    // NO whitelist / PZ coupling in the panel-user creation path
    expect(handler).not.toContain('whitelistApi');
    expect(handler).not.toContain('Add Whitelist User');
    expect(handler).not.toMatch(/may connect once added/);
  });

  it('whitelist dialog uses whitelistApi.addUser and NEVER the panel-user API', () => {
    const handler = between('openAddWhitelistUser = () =>', 'openAddSteam = () =>');
    expect(handler).toContain('kicker: "WHITELIST"');
    expect(handler).toContain('title: "Add Whitelist User"');
    expect(handler).toContain('whitelistApi.addUser');
    expect(handler).not.toContain('usersApi');
    // whitelist dialog only asks for a username (no password/role)
    expect(handler).not.toContain('showPassword');
    expect(handler).not.toContain('showSelect');
  });

  it('the actions map wires each button to its own handler, with no duplicate key', () => {
    const actions = between('actions: {', 'togglePause');
    expect((actions.match(/openAddUser: this\.openAddUser/g) || []).length).toBe(1);
    expect((actions.match(/openAddWhitelistUser: this\.openAddWhitelistUser/g) || []).length).toBe(1);
  });

  it('panel roles map friendly labels to backend role ids (admin/moderator/readonly, not PZ levels)', () => {
    const roles = between('PANEL_ROLES = [', '];');
    expect(roles).toContain('{ id: "admin", label: "Admin" }');
    expect(roles).toContain('{ id: "moderator", label: "Moderator" }');
    expect(roles).toContain('{ id: "readonly", label: "Read Only" }');
    // no Project Zomboid access levels leaking into panel auth
    expect(roles).not.toMatch(/GM|Observer|Overseer/);
  });
});

describe('backend panel-user module never touches the PZ whitelist / RCON / player domain', () => {
  it('users routes + service import no whitelist/rcon/player code', () => {
    // Strip comments first — a doc line that PROMISES "never touches whitelist/RCON"
    // must not itself trip the guard; we care about executable code only.
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const f of ['src/modules/users/routes.ts', 'src/modules/users/service.ts']) {
      const code = stripComments(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
      expect(code, `${f} must not reference whitelist`).not.toMatch(/whitelist/i);
      expect(code, `${f} must not reference rcon`).not.toMatch(/\brcon\b/i);
      expect(code, `${f} must not reference the players module`).not.toMatch(/modules\/players/);
    }
  });
});
