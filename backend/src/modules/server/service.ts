import os from 'node:os';
import { env } from '../../config/env';
import { runtime } from '../../integrations/runtime';
import type { RuntimeState } from '../../integrations/runtime';
import { rcon } from '../../integrations/rcon/service';
import { rconCommands } from '../../integrations/rcon/commands';
import { parsePlayers, parseSaveResult } from '../../integrations/rcon/parsers';
import { readServerIni } from '../../integrations/zomboid-files/service';
import { logger } from '../../shared/logger';

export type ServerStatus =
  | 'online'
  | 'offline'
  | 'starting'
  | 'stopping'
  | 'restarting'
  | 'updating'
  | 'unreachable';

export interface ServerOverview {
  name: string;
  subtitle: string;
  status: ServerStatus;
  playersOnline: number;
  maxPlayers: number;
  uptimeSeconds: number;
  cpuUsage: number;
  memoryUsed: number; // GB — real process memory (never the configured ceiling)
  memoryLimit: number | null; // GB — configured max Java heap; null when unknown (never a hardcoded guess)
  version: string | null;
  ip: string;
  /** Runtime adapter managing this server ('systemd' | 'amp' | 'standalone'). */
  runtime: string;
}

export interface ResourcePoint {
  timestamp: string;
  cpu: number;
  memoryPercent: number;
}

const toGB = (bytes: number | null): number => (bytes == null ? 0 : Math.round((bytes / 1073741824) * 100) / 100);

/** Bounded in-memory resource history for the dashboard chart. */
class MetricsHistory {
  private points: ResourcePoint[] = [];
  push(cpu: number, memoryPercent: number): void {
    this.points.push({ timestamp: new Date().toISOString(), cpu, memoryPercent });
    if (this.points.length > env.METRICS_HISTORY_POINTS) {
      this.points = this.points.slice(-env.METRICS_HISTORY_POINTS);
    }
  }
  list(): ResourcePoint[] {
    return this.points.slice();
  }
}

export const metricsHistory = new MetricsHistory();

function primaryIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

/** Map runtime state + RCON readiness to the frontend server status. */
function deriveStatus(state: RuntimeState, rconReady: boolean): ServerStatus {
  switch (state) {
    case 'running':
      // Process is up; it is only "online" once RCON accepts commands.
      return rconReady ? 'online' : 'starting';
    case 'stopped':
      return 'offline';
    case 'starting':
      return 'starting';
    case 'stopping':
      return 'stopping';
    case 'restarting':
      return 'restarting';
    case 'updating':
      return 'updating';
    default:
      return 'unreachable';
  }
}

let cachedIni: { at: number; values: Record<string, string> } | null = null;
async function iniValues(): Promise<Record<string, string>> {
  if (cachedIni && Date.now() - cachedIni.at < 5000) return cachedIni.values;
  try {
    const { values } = await readServerIni();
    cachedIni = { at: Date.now(), values };
    return values;
  } catch {
    return cachedIni?.values ?? {};
  }
}

export async function getOverview(): Promise<ServerOverview> {
  const [status, metrics] = await Promise.all([runtime.getStatus(), runtime.getMetrics()]);
  const ini = await iniValues();

  let playersOnline = 0;
  let rconReady = false;
  if (status.state === 'running') {
    try {
      const raw = await rcon.exec(rconCommands.players());
      playersOnline = parsePlayers(raw).count;
      rconReady = true;
    } catch {
      rconReady = false;
    }
  }

  // Configured max heap from the authoritative JVM source (cmdline -Xmx or
  // ProjectZomboid64.json, resolved by the metrics layer). Honest null when
  // unknown — never a hardcoded fallback.
  const memLimit = metrics.memoryLimitBytes ? toGB(metrics.memoryLimitBytes) : null;
  // Player-facing game address is derived entirely from the managed server's own
  // config (server_browser_announced_ip / DefaultPort) — never a hardcoded port.
  const announced = ini['server_browser_announced_ip'];
  const host = announced || primaryIp();
  const port = ini['DefaultPort'];

  return {
    name: ini['PublicName'] || env.PZ_SERVER_NAME,
    subtitle: 'Project Zomboid Dedicated Server',
    status: deriveStatus(status.state, rconReady),
    playersOnline,
    maxPlayers: Number(ini['MaxPlayers'] || 32),
    uptimeSeconds: metrics.uptimeSeconds ?? 0,
    cpuUsage: metrics.cpuPercent ?? 0,
    memoryUsed: toGB(metrics.memoryBytes),
    memoryLimit: memLimit,
    version: null, // Build number is not exposed by RCON/runtime here; see docs.
    ip: port ? `${host}:${port}` : host,
    // The frontend derives its runtime badge from this — never a hardcoded label.
    runtime: runtime.capabilities().runtime,
  };
}

/** Sample metrics into the bounded history (called by a periodic timer). */
export async function sampleMetrics(): Promise<void> {
  try {
    const status = await runtime.getStatus();
    if (status.state !== 'running') return;
    const m = await runtime.getMetrics();
    const memPct = m.memoryBytes != null && m.memoryLimitBytes ? Math.round((m.memoryBytes / m.memoryLimitBytes) * 100) : 0;
    metricsHistory.push(m.cpuPercent ?? 0, memPct);
  } catch (e) {
    logger.debug({ err: (e as Error).message }, 'metrics sample failed');
  }
}

export async function saveWorld(): Promise<{ ok: boolean; durationMs: number; message: string }> {
  const started = Date.now();
  const raw = await rcon.exec(rconCommands.save());
  const parsed = parseSaveResult(raw);
  return { ok: parsed.ok, durationMs: Date.now() - started, message: parsed.message };
}

export async function broadcast(message: string): Promise<{ ok: boolean }> {
  await rcon.exec(rconCommands.servermsg(message));
  return { ok: true };
}
