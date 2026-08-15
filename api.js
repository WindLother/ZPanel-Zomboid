// Real API adapter. Drop-in replacement for mockApi.js: it exposes the SAME
// logical services (serverApi, playersApi, …) but every call performs an HTTP
// request to the ZPanel backend, which aggregates the server runtime
// (systemd/AMP/standalone) + RCON + PZ files.
//
// Design rules honored here:
//   * one clean transport abstraction (http) — no fetch() scattered in the UI
//   * cookies + CSRF handled centrally; secrets never live in the browser
//   * NO fabricated runtime state: serverApi.tick()/getHistorySync() return the
//     last value fetched from the backend instead of simulating the server
//   * the panel must be served from the SAME ORIGIN as the backend (or set
//     window.ZPANEL_API_BASE) so the session cookie and CSRF flow work.

const API = (typeof window !== "undefined" && window.ZPANEL_API_BASE) || "";

/* ----------------------------------------------------------- auth + transport */

let csrfToken = null;
let authPromise = null;

function ensureAuth() {
  if (authPromise) return authPromise;
  authPromise = (async () => {
    const me = await fetch(API + "/api/auth/me", { credentials: "include" }).then((r) => r.json());
    if (me.authenticated) {
      csrfToken = me.csrfToken;
      return;
    }
    await showLogin();
  })();
  return authPromise;
}

async function http(method, path, body) {
  await ensureAuth();
  const headers = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && csrfToken) headers["x-csrf-token"] = csrfToken;
  let res = await fetch(API + path, {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    // Session expired mid-session — re-authenticate and retry once.
    authPromise = null;
    csrfToken = null;
    await ensureAuth();
    if (csrfToken && method !== "GET") headers["x-csrf-token"] = csrfToken;
    res = await fetch(API + path, {
      method,
      credentials: "include",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error((data && data.error && data.error.message) || res.statusText);
    err.code = data && data.error && data.error.code;
    throw err;
  }
  return data;
}

const get = (p) => http("GET", p);
const post = (p, b) => http("POST", p, b);
const put = (p, b) => http("PUT", p, b);
const del = (p) => http("DELETE", p);

/* -------------------------------------------------------------- login overlay */

function showLogin(message) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#100f0d;display:flex;align-items:center;justify-content:center;font-family:'IBM Plex Sans',system-ui,sans-serif";
    wrap.innerHTML =
      '<form style="background:#141210;border:1px solid #26231e;border-radius:10px;padding:28px;width:320px;display:flex;flex-direction:column;gap:14px">' +
      '<div style="font:600 10px/1 \'IBM Plex Mono\',monospace;letter-spacing:.18em;color:#d9a44c">PROJECT ZOMBOID</div>' +
      '<div style="font:600 16px/1.2 sans-serif;color:#e9e5dd">Server Control · Sign in</div>' +
      '<div data-err style="color:#c4553f;font:500 12px/1.4 sans-serif;min-height:0"></div>' +
      '<input name="u" placeholder="Username" autocomplete="username" style="padding:9px 11px;border-radius:6px;border:1px solid #34302a;background:#1c1a16;color:#e9e5dd">' +
      '<input name="p" type="password" placeholder="Password" autocomplete="current-password" style="padding:9px 11px;border-radius:6px;border:1px solid #34302a;background:#1c1a16;color:#e9e5dd">' +
      '<button type="submit" style="padding:10px;border:0;border-radius:6px;background:#2a2113;color:#e8bf74;font:600 13px sans-serif;cursor:pointer">Sign in</button>' +
      "</form>";
    const form = wrap.querySelector("form");
    const errBox = wrap.querySelector("[data-err]");
    if (message) errBox.textContent = message;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errBox.textContent = "";
      try {
        const res = await fetch(API + "/api/auth/login", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: form.u.value, password: form.p.value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data.error && data.error.message) || "Login failed");
        csrfToken = data.csrfToken;
        document.body.removeChild(wrap);
        resolve();
      } catch (err) {
        errBox.textContent = err.message;
      }
    });
    document.body.appendChild(wrap);
    form.u.focus();
  });
}

/* ----------------------------------------------------------------- id mapping */
// The UI dropdowns use human labels; the backend needs real PZ identifiers.
// These maps are best-effort for Build 42 and are the single place to correct
// an identifier if the game renames one.
const ITEM_IDS = {
  "Baseball Bat": "Base.BaseballBat",
  Bandage: "Base.Bandage",
  "Canned Beans": "Base.TinnedBeans",
  "Hunting Rifle": "Base.HuntingRifle",
  "Water Bottle": "Base.WaterBottleFull",
  Screwdriver: "Base.Screwdriver",
};
const SKILL_IDS = {
  Carpentry: "Woodwork",
  Cooking: "Cooking",
  Fitness: "Fitness",
  Strength: "Strength",
  Aiming: "Aiming",
  Mechanics: "Mechanics",
};
const VEHICLE_IDS = {
  "Chevalier Dart": "Base.CarNormal",
  "Franklin Valuline Van": "Base.VanSeats",
  "Dash Rancher": "Base.PickUpTruck",
  "Masterson Horizon": "Base.CarLuxury",
  "Police Cruiser": "Base.CarStatePolice",
};
const mapId = (m, v) => m[v] || v;

/* ---------------------------------------------------------- server-state cache */
// Backend is the single source of truth. We keep the latest fetched values so
// the DC template's synchronous tick()/getHistorySync() can return real data
// (fetched via polling) instead of simulating the server locally.
let srvCache = null;
let historyCache = [];

const toChart = (points) =>
  (points || []).map((p) => ({ cpu: Math.round(p.cpu), mem: Math.round(p.memoryPercent) }));

async function refreshHistory() {
  try {
    historyCache = toChart(await get("/api/server/history"));
  } catch (_) {
    /* keep last */
  }
}

/* ----------------------------------------------------------------- activity map */

function humanizeAudit(e) {
  const t = e.target ? " " + e.target : "";
  const d = e.details || {};
  const map = {
    "auth.login": e.success ? "signed in" : "failed to sign in",
    "auth.logout": "signed out",
    "server.save": "saved the world",
    "server.broadcast": "broadcast a message",
    "server.start": "started the server",
    "server.stop": "stopped the server",
    "server.restart": "restarted the server",
    "server.update": "updated the server",
    "server.restart.schedule": "scheduled a restart",
    "player.kick": "kicked" + t,
    "player.ban": "banned" + t,
    "player.access": "changed access level for" + t,
    "player.power": "toggled a power for" + t,
    "player.giveItem": "gave an item to" + t,
    "player.giveXp": "gave XP to" + t,
    "player.spawnVehicle": "spawned a vehicle for" + t,
    "user.create": "created panel user" + t,
    "user.roleChange": "changed the role of panel user" + t,
    "user.enable": "enabled panel user" + t,
    "user.disable": "disabled panel user" + t,
    "user.resetPassword": "reset the password of panel user" + t,
    "user.delete": "deleted panel user" + t,
    "whitelist.addUser": "added" + t + " to the whitelist",
    "whitelist.removeUser": "removed" + t + " from the whitelist",
    "whitelist.addSteamId": "whitelisted Steam ID" + t,
    "whitelist.removeSteamId": "removed Steam ID" + t,
    "settings.save": "changed server settings",
    "sandbox.save": "changed sandbox settings",
    "console.command": "ran console command" + t,
  };
  let text = map[e.action] || e.action + t;
  if (e.action.startsWith("admin.")) text = "used admin tool: " + e.action.slice(6);
  let detail;
  if (d.reason) detail = "Reason: " + d.reason;
  else if (d.message) detail = '"' + d.message + '"';
  else if (e.action === "server.broadcast" && d.message) detail = '"' + d.message + '"';
  return { text, detail };
}

// The actor's own panel role, recorded server-side with each audit row, so the
// admin reading the trail can see WHICH role performed a privileged mutation
// (e.g. a moderator saving settings). Older rows predate the column -> no chip.
const AUDIT_ROLE_LABEL = { admin: "Admin", moderator: "Moderator", readonly: "Read Only" };

function mapActivity(events) {
  const today = new Date().toDateString();
  const yest = new Date(Date.now() - 86400000).toDateString();
  return (events || []).map((e) => {
    const dt = new Date(e.timestamp);
    const day = dt.toDateString() === today ? "Today" : dt.toDateString() === yest ? "Yesterday" : dt.toLocaleDateString();
    const { text, detail } = humanizeAudit(e);
    return {
      at: dt.toTimeString().slice(0, 5), day, actor: e.actorName,
      role: AUDIT_ROLE_LABEL[e.actorRole] || "",
      text, detail,
    };
  });
}

let activityCache = [];
async function refreshActivity() {
  try {
    activityCache = mapActivity(await get("/api/activity?limit=100"));
  } catch (_) {
    /* keep last */
  }
  return activityCache;
}

/* ------------------------------------------------------------------- services */

export const serverApi = {
  async getOverview() {
    srvCache = await get("/api/server");
    return srvCache;
  },
  async getHistory() {
    await refreshHistory();
    return historyCache;
  },
  async start() {
    return post("/api/server/start", {});
  },
  async stop() {
    return post("/api/server/stop", {});
  },
  async restart(opts = {}) {
    return post("/api/server/restart", { delayMinutes: opts.delayMinutes || 0, broadcast: opts.broadcast });
  },
  async save() {
    return post("/api/server/save", {});
  },
  async broadcast(message) {
    return post("/api/server/broadcast", { message });
  },
  // Synchronous hooks used by the DC template's live loop: return the latest
  // backend-fetched values (and kick off an async refresh); never simulate.
  tick() {
    serverApi.getOverview().catch(() => {});
    refreshHistory();
    return srvCache;
  },
  getHistorySync() {
    return historyCache;
  },
  setStatus() {
    // Server status is owned by the backend; this preview hook is a no-op.
    return srvCache;
  },
};

export const playersApi = {
  list: () => get("/api/players"),
  get: (username) => get("/api/players/" + encodeURIComponent(username)),
  kick: (username, reason) => post("/api/players/" + encodeURIComponent(username) + "/kick", { reason }),
  ban: (username, opts = {}) =>
    post("/api/players/" + encodeURIComponent(username) + "/ban", { reason: opts.reason, banIp: !!opts.banIp }),
  setAccessLevel: (username, level) => post("/api/players/" + encodeURIComponent(username) + "/access", { level }),
  runPower: (username, power, on) =>
    post("/api/players/" + encodeURIComponent(username) + "/powers/" + encodeURIComponent(power), { on }),
  giveItem: (username, item, count) =>
    post("/api/players/" + encodeURIComponent(username) + "/items", { item: mapId(ITEM_IDS, item), count: Number(count) || 1 }),
  giveXp: (username, skill, amount) =>
    post("/api/players/" + encodeURIComponent(username) + "/xp", { skill: mapId(SKILL_IDS, skill), amount: Number(amount) || 1 }),
  spawnVehicle: (username, vehicle) =>
    post("/api/players/" + encodeURIComponent(username) + "/vehicles", { vehicle: mapId(VEHICLE_IDS, vehicle) }),
};

export const whitelistApi = {
  list: () => get("/api/whitelist"),
  addUser: (u) => post("/api/whitelist/users", { username: u }),
  removeUser: (u) => del("/api/whitelist/users/" + encodeURIComponent(u)),
  addSteamId: (id) => post("/api/whitelist/steamids", { steamId: id }),
  removeSteamId: (id) => del("/api/whitelist/steamids/" + encodeURIComponent(id)),
};

export const settingsApi = {
  get: () => get("/api/settings"),
  // Returns the full save result: { groups, saved, restartRequired, applied,
  // durableServerSettings }. The UI renders `groups` (server-authoritative,
  // with secret values re-masked) and reports `restartRequired` from the
  // backend instead of guessing client-side. A save NEVER restarts the game
  // server — restarting is a separate, separately-authorized action.
  save: (next) => put("/api/settings", next),
};

export const sandboxApi = {
  get: () => get("/api/sandbox"),
  async save(next) {
    const res = await put("/api/sandbox", next);
    return res.categories;
  },
};

export const modsApi = {
  // Returns WorkshopItem[] (each with a modIds[] array — one Workshop item can
  // provide several Mod IDs).
  list: () => get("/api/mods"),
  // Resolve a Workshop ID's real Mod ID(s) from downloaded content on the server.
  lookup: (workshopId) => post("/api/mods/lookup", { workshopId }),
  // Structured add: the panel sends { workshopId, modIds } — never a raw Mods= string.
  async add({ workshopId, modIds }) {
    return (await post("/api/mods", { workshopId, modIds })).items;
  },
  async remove(workshopId) {
    return (await del("/api/mods/" + encodeURIComponent(workshopId))).items;
  },
  async removeStandalone(modId) {
    return (await del("/api/mods/standalone/" + encodeURIComponent(modId))).items;
  },
  async toggle(workshopId) {
    return (await post("/api/mods/" + encodeURIComponent(workshopId) + "/toggle", {})).items;
  },
  async move(workshopId, dir) {
    return (await post("/api/mods/" + encodeURIComponent(workshopId) + "/move", { direction: dir })).items;
  },
  // Returns the full report: { accepted, verdict, checked, outdated,
  // namedByServer, items[], message, notes[] }. Each item carries which mod it
  // is (workshopId + modIds + name), whether Steam has it downloaded, the
  // installed content version, and needsUpdate (null when Project Zomboid did
  // not name that item — never guessed).
  checkUpdates: () => post("/api/mods/check-updates", {}),
  async updateAll() {
    // Content updates go through the runtime's server-update path (when the
    // runtime supports updates), not a parallel SteamCMD. Return the current
    // list unchanged.
    await post("/api/mods/update", {}).catch(() => {});
    return get("/api/mods");
  },
};

export const logsApi = {
  recent: () => get("/api/logs?limit=200"),
  subscribe(cb) {
    const es = new EventSource(API + "/api/logs/stream", { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        cb(JSON.parse(ev.data));
      } catch (_) {
        /* ignore keepalive lines */
      }
    };
    return () => es.close();
  },
};

export const consoleApi = {
  recent: () => get("/api/console"),
  send: (cmd) => post("/api/console/command", { command: cmd }),
};

export const adminApi = {
  trigger: (action) => post("/api/admin/actions/" + encodeURIComponent(action), {}),
};

export const activityApi = {
  async list() {
    return refreshActivity();
  },
  // The backend is the source of truth. record() no longer writes locally — it
  // triggers a refresh (the action endpoint already logged the event) and
  // returns the cache optimistically.
  record() {
    refreshActivity();
    return activityCache;
  },
  sync() {
    return activityCache;
  },
};

/* --------------------------------------------------- panel auth + user mgmt */

export const authApi = {
  // Current panel user + CSRF token (used by the UI to show who is logged in
  // and to gate the admin-only Users & Access page).
  me: () => get("/api/auth/me"),
  logout: () => post("/api/auth/logout", {}),
};

// PANEL users (web-admin accounts) — NOT Project Zomboid players. Admin-only.
export const usersApi = {
  list: () => get("/api/users"),
  create: ({ username, password, role }) => post("/api/users", { username, password, role }),
  setRole: (id, role) => http("PATCH", "/api/users/" + encodeURIComponent(id), { role }),
  setActive: (id, active) => http("PATCH", "/api/users/" + encodeURIComponent(id), { active }),
  resetPassword: (id, password) => post("/api/users/" + encodeURIComponent(id) + "/reset-password", { password }),
  remove: (id) => del("/api/users/" + encodeURIComponent(id)),
};
