import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Regression guards for the production RBAC/bootstrap bug: a moderator's
 * dashboard hung forever on "Loading server status..." because load() fetched
 * ALL domains (including the admin-only /api/console) in one Promise.all
 * BEFORE resolving the user's role — the 403 rejected the whole bootstrap and
 * `loading: false` was never reached.
 *
 * The frontend is a compiled DC-runtime template, so these assert the wiring
 * at source level (same approach as frontend-userdialog.test.ts). Backend
 * authorization remains the real boundary and is tested in *-authz suites.
 */
const html = fs.readFileSync(path.join(__dirname, '..', '..', 'Zomboid_Server_Control.dc.html'), 'utf8');

function section(start: string, end: string): string {
  const a = html.indexOf(start);
  const b = html.indexOf(end, a + start.length);
  expect(a, `anchor not found: ${start}`).toBeGreaterThanOrEqual(0);
  expect(b, `anchor not found: ${end}`).toBeGreaterThan(a);
  return html.slice(a, b);
}

describe('bootstrap: auth first, role-aware fetching, no permanent spinner', () => {
  const load = section('async load()', 'loadPageData(api, role) {');
  const pageData = section('loadPageData(api, role) {', 'playerMenuItems(p)');

  it('resolves the panel user BEFORE any role-dependent request', () => {
    const meAt = load.indexOf('authApi.me()');
    const criticalAt = load.indexOf('serverApi.getOverview()');
    expect(meAt).toBeGreaterThan(-1);
    expect(criticalAt).toBeGreaterThan(meAt);
  });

  it('the critical dashboard bootstrap contains ONLY all-role endpoints', () => {
    const start = load.indexOf('Promise.all');
    const critical = load.slice(start, load.indexOf('setState', start));
    expect(critical).toContain('serverApi.getOverview()');
    expect(critical).toContain('serverApi.getHistory()');
    expect(critical).toContain('playersApi.list()');
    for (const forbidden of ['consoleApi', 'activityApi', 'usersApi', 'settingsApi', 'sandboxApi', 'modsApi', 'whitelistApi']) {
      expect(critical, `${forbidden} must not block the dashboard`).not.toContain(forbidden);
    }
  });

  it('admin-only domains (console, activity) are fetched ONLY for role === "admin"', () => {
    const adminBlock = pageData.slice(pageData.indexOf('role === "admin"'));
    expect(pageData).toContain('if (role === "admin")');
    expect(adminBlock).toContain('consoleApi.recent()');
    expect(adminBlock).toContain('activityApi.list()');
    // and never outside that guard
    const beforeGuard = pageData.slice(0, pageData.indexOf('role === "admin"'));
    expect(beforeGuard).not.toContain('consoleApi');
    expect(beforeGuard).not.toContain('activityApi');
  });

  it('per-domain page data failures are caught; the loading invariant holds via try/catch', () => {
    // every bootstrap ends in loading:false — the catch path sets it with an error
    expect(load).toMatch(/catch \(e\) \{[\s\S]*loading: false[\s\S]*error:/);
    // page-data fetches carry their own .catch (never break the dashboard)
    expect(pageData).toMatch(/\.catch\(\(e\) =>/);
  });

  it('logActivity never refreshes /api/activity for non-admin roles', () => {
    const la = section('logActivity(text, detail) {', 'go = (route)');
    expect(la).toMatch(/role !== "admin"\) return/);
  });
});

describe('PAGE_ACCESS: navigation + direct-route protection mirror backend guards', () => {
  const access = section('const PAGE_ACCESS = {', '};');

  it('console, users and activity are admin-only pages', () => {
    for (const page of ['console', 'users', 'activity']) {
      expect(access).toMatch(new RegExp(`${page}: \\["admin"\\]`));
    }
  });

  it('admin tools page allows admin + moderator (backend requires moderator)', () => {
    expect(access).toMatch(/admin: \["admin", "moderator"\]/);
  });

  it('dashboard and read pages allow every role (canonical ids, no read_only variant)', () => {
    for (const page of ['dashboard', 'players', 'whitelist', 'settings', 'sandbox', 'mods', 'logs']) {
      expect(access).toMatch(new RegExp(`${page}: \\["admin", "moderator", "readonly"\\]`));
    }
    expect(access).not.toContain('read_only');
  });

  it('navigation, go() and componentDidUpdate all enforce the map', () => {
    expect(html).toMatch(/filter\(\(it\) => canAccessPage\(it\.id, navRole\)\)/); // nav
    expect(html).toMatch(/go = \(route\) => \(\) =>[\s\S]{0,200}canAccessPage\(route/); // route switch
    expect(html).toMatch(/!canAccessPage\(this\.state\.route, this\.state\.me\.role\)[\s\S]{0,80}route: "dashboard"/); // direct-route fallback
  });
});

describe('role-gated controls (cosmetic mirror of backend authz)', () => {
  it('start/stop render only for admin (they leave the server down)', () => {
    for (const action of ['actions.openStop', 'actions.start ']) {
      const idx = html.indexOf(action);
      expect(idx).toBeGreaterThan(-1);
      const before = html.lastIndexOf('<sc-if value="{{ can.admin }}">', idx);
      const gap = html.slice(before, idx);
      expect(before, `${action} must sit inside a can.admin gate`).toBeGreaterThan(-1);
      expect(gap).not.toContain('</sc-if>'); // gate not closed before the button
    }
  });

  it('restart renders for moderator+ (backend allows moderator)', () => {
    const idx = html.indexOf('actions.openRestart');
    expect(idx).toBeGreaterThan(-1);
    const gate = html.lastIndexOf('<sc-if value="{{ can.moderate }}">', idx);
    expect(gate, 'restart must sit inside a can.moderate gate').toBeGreaterThan(-1);
    expect(html.slice(gate, idx)).not.toContain('</sc-if>');
  });

  it('save/broadcast render for moderator+ (backend allows moderator)', () => {
    expect(html).toContain('<sc-if value="{{ can.moderate }}">\n<button type="button" onClick="{{ actions.openBroadcast }}"');
    expect(html).toMatch(/can\.moderate[\s\S]{0,600}BROADCAST MESSAGE/);
  });

  it('dashboard RECENT ACTIVITY panel is admin-gated (its API is admin-only)', () => {
    expect(html).toMatch(/can\.admin[\s\S]{0,400}RECENT ACTIVITY/);
  });

  it('whitelist mutations stay admin-gated', () => {
    expect(html).toMatch(/can\.admin[^\n]*openAddWhitelistUser/);
    expect(html).toMatch(/can\.admin[^\n]*openAddSteam/);
  });

  it('settings/sandbox save+discard are gated by their CAPABILITY, not by can.admin', () => {
    // The capability is admin + moderator (backend: requireRole('moderator')),
    // so a plain can.admin gate here would wrongly hide Save from moderators.
    for (const [action, cap] of [
      ['actions.saveSettings', 'can.editServerSettings'],
      ['actions.discardSettings', 'can.editServerSettings'],
      ['actions.saveSandbox', 'can.editSandbox'],
      ['actions.discardSandbox', 'can.editSandbox'],
    ]) {
      const idx = html.indexOf(action);
      expect(idx, `${action} not found`).toBeGreaterThan(-1);
      const gate = html.lastIndexOf(`<sc-if value="{{ ${cap} }}">`, idx);
      expect(gate, `${action} must sit inside a ${cap} gate`).toBeGreaterThan(-1);
      expect(html.slice(gate, idx), `${cap} gate closed before ${action}`).not.toContain('</sc-if>');
    }
    expect(html).not.toMatch(/can\.admin[\s\S]{0,400}actions\.saveSettings/);
    expect(html).not.toMatch(/can\.admin[\s\S]{0,200}actions\.saveSandbox/);
  });
});

/**
 * The intentional RBAC change: moderators may EDIT Server Settings and Sandbox
 * Settings. These guard both halves of it — moderators must not lose the
 * controls, and readonly must not gain them (nor be able to fire a PUT).
 */
describe('CAPABILITIES: settings/sandbox writes are admin + moderator, nothing else moves', () => {
  const caps = section('const CAPABILITIES = {', '};');

  it('the two config editors are admin + moderator', () => {
    expect(caps).toMatch(/editServerSettings: \["admin", "moderator"\]/);
    expect(caps).toMatch(/editSandbox: \["admin", "moderator"\]/);
  });

  it('users, console, activity, lifecycle and connections stay admin-only', () => {
    for (const cap of ['manageUsers', 'useConsole', 'viewActivity', 'controlLifecycle', 'viewConnections']) {
      expect(caps, `${cap} must remain admin-only`).toMatch(new RegExp(`${cap}: \\["admin"\\]`));
    }
    // no capability may be granted to readonly
    expect(caps).not.toContain('readonly');
  });

  it('the render pass derives the two flags from the capability map', () => {
    expect(html).toContain('const canEditServerSettings = hasCapability("editServerSettings", role);');
    expect(html).toContain('const canEditSandbox = hasCapability("editSandbox", role);');
    expect(html).toMatch(/can: \{ admin: isAdmin, moderate: canModerate, editServerSettings: canEditServerSettings, editSandbox: canEditSandbox \}/);
  });

  it('field controls are decorated with the capability and render disabled without it', () => {
    // decorate() receives the capability and locks the control (not just the button)
    expect(html).toMatch(/decorate\(f, "set-[^\n]*, canEditServerSettings\)/);
    expect(html).toMatch(/decorate\(f, "sb-[^\n]*, canEditSandbox\)/);
    const dec = section('decorate(f, id, onChange, dirty, editable) {', 'mods */');
    expect(dec).toContain('const locked = editable === false;');
    expect(dec).toMatch(/if \(locked\) onChange = \(\) => \{\};/); // edits cannot even create dirty state
    // every config input/select/textarea/toggle binds disabled to that flag
    const controls = html.match(/<(input|select|textarea|button)[^>]*id="\{\{ f\.id \}\}"[^>]*>/g) || [];
    expect(controls.length).toBeGreaterThanOrEqual(7);
    for (const c of controls) expect(c, c.slice(0, 80)).toContain('disabled="{{ f.locked }}"');
  });

  it('save handlers refuse without the capability, so no forbidden PUT is ever sent', () => {
    const saveSettings = section('saveSettings = async () => {', 'discardSettings =');
    const saveSandbox = section('saveSandbox = async () => {', 'discardSandbox =');
    expect(saveSettings).toMatch(/if \(!this\.may\("editServerSettings"\)\).*return;/);
    expect(saveSandbox).toMatch(/if \(!this\.may\("editSandbox"\)\).*return;/);
    // the guard precedes the request in both
    expect(saveSettings.indexOf('may("editServerSettings")')).toBeLessThan(saveSettings.indexOf('settingsApi.save'));
    expect(saveSandbox.indexOf('may("editSandbox")')).toBeLessThan(saveSandbox.indexOf('sandboxApi.save'));
    expect(html).toContain('may(capability) { return hasCapability(capability, this.state.me ? this.state.me.role : null); }');
  });

  it('saving settings never triggers a restart — it only reports restartRequired', () => {
    const saveSettings = section('saveSettings = async () => {', 'discardSettings =');
    expect(saveSettings).toContain('res.restartRequired');
    for (const lifecycle of ['serverApi.restart', 'serverApi.start', 'serverApi.stop', 'serverApi.update']) {
      expect(saveSettings, `saving must not call ${lifecycle}`).not.toContain(lifecycle);
    }
    const saveSandbox = section('saveSandbox = async () => {', 'discardSandbox =');
    for (const lifecycle of ['serverApi.restart', 'serverApi.start', 'serverApi.stop', 'serverApi.update']) {
      expect(saveSandbox, `saving must not call ${lifecycle}`).not.toContain(lifecycle);
    }
  });

  it('moderators still get no console/users/activity navigation', () => {
    const access = section('const PAGE_ACCESS = {', '};');
    for (const page of ['console', 'users', 'activity']) {
      expect(access).toMatch(new RegExp(`${page}: \\["admin"\\]`));
    }
  });

  it('mod curation (add/remove/toggle/update-check) renders for moderator+', () => {
    expect(html).toMatch(/can\.moderate[^\n]*actions\.openAddMod/);
    expect(html).toMatch(/can\.moderate[^\n]*m\.remove/);
    expect(html).toMatch(/can\.moderate[^\n]*m\.toggle/);
    expect(html).toMatch(/can\.moderate[^\n]*actions\.checkMods/);
  });

  it('mod load-order moves and content updates stay admin-gated', () => {
    expect(html).toMatch(/can\.admin[^\n]*actions\.updateMods/);
    expect(html).toMatch(/can\.admin[^\n]*m\.up/);
  });

  it('player context menu is role-gated in code (kick/ban moderator+, access admin)', () => {
    const menu = section('playerMenuItems(p) {', 'return items;');
    expect(menu).toMatch(/role === "admin" \|\| role === "moderator"/);
    expect(menu).toMatch(/role === "admin"\) \{[\s\S]*Change Access Level/);
  });

  it('admin-tools page filters tools by per-tool minRole (mirrors the registry)', () => {
    expect(html).toMatch(/minRole: "admin"[^\n]*Create Horde|Create Horde[\s\S]{0,200}minRole: "admin"/);
    expect(html).toMatch(/tools\.filter\(\(t\) => \(roleRank\[role\] \|\| 0\) >= roleRank\[t\.minRole/);
  });
});
