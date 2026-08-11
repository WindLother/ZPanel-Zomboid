import { env } from '../../config/env';
import { err } from '../../shared/errors';
import { logger } from '../../shared/logger';
import type { AmpConsoleLine, InstanceState, InstanceStatus } from './types';

/**
 * AMP (CubeCoders) HTTP API client. AMP exposes a uniform JSON-RPC-style API:
 *
 *   POST {base}/API/{Module}/{Method}
 *   Accept: application/json
 *   body: { ...params, SESSIONID }
 *
 * Auth: POST /API/Core/Login { username, password, token:"", rememberMe:false }
 * returns { success, sessionID }. We keep the session and re-login on 'Unknown
 * or expired session' style failures. Credentials are read from env and never
 * logged or returned to the browser.
 *
 * This talks to the *instance* webserver (AMP_BASE_URL), which for a
 * GenericModule Project Zomboid instance is the correct target for Core
 * lifecycle + status. If credentials are not configured the AmpService falls
 * back to the ampinstmgr CLI (see cli.ts).
 */
export class AmpApiClient {
  private sessionId: string | null = null;
  private loginPromise: Promise<string> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly username: string,
    private readonly password: string,
  ) {}

  private async rawCall<T>(endpoint: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.baseUrl}/API/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw err.amp(`AMP API ${endpoint} returned HTTP ${res.status}.`);
    return (await res.json()) as T;
  }

  private async login(): Promise<string> {
    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = (async () => {
      const result = await this.rawCall<{ success?: boolean; sessionID?: string; result?: number }>(
        'Core/Login',
        { username: this.username, password: this.password, token: '', rememberMe: false },
      );
      if (!result.sessionID) throw err.amp('AMP login failed (check AMP_USERNAME/AMP_PASSWORD).');
      this.sessionId = result.sessionID;
      logger.debug('AMP API session established');
      return result.sessionID;
    })();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  /** Call an authenticated endpoint, logging in / retrying once on session loss. */
  async call<T>(endpoint: string, params: Record<string, unknown> = {}): Promise<T> {
    const session = this.sessionId ?? (await this.login());
    const attempt = (sid: string) => this.rawCall<T>(endpoint, { ...params, SESSIONID: sid });
    try {
      const out = await attempt(session);
      if (this.looksLikeSessionError(out)) {
        this.sessionId = null;
        return attempt(await this.login());
      }
      return out;
    } catch (e) {
      // One retry after a fresh login for transient auth/network errors.
      this.sessionId = null;
      const sid = await this.login();
      try {
        return await attempt(sid);
      } catch {
        throw e instanceof Error ? e : err.amp('AMP API call failed.');
      }
    }
  }

  private looksLikeSessionError(out: unknown): boolean {
    if (out && typeof out === 'object') {
      const s = JSON.stringify(out).toLowerCase();
      return s.includes('session') && (s.includes('expired') || s.includes('invalid'));
    }
    return false;
  }

  // --- High-level operations ------------------------------------------------

  async getStatus(): Promise<InstanceStatus> {
    const raw = await this.call<AmpStatusResponse>('Core/GetStatus');
    return normalizeStatus(raw);
  }

  async start(): Promise<void> {
    await this.call('Core/Start');
  }
  async stop(): Promise<void> {
    await this.call('Core/Stop');
  }
  async restart(): Promise<void> {
    await this.call('Core/Restart');
  }
  async update(): Promise<void> {
    await this.call('Core/Update');
  }

  async sendConsole(command: string): Promise<void> {
    await this.call('Core/SendConsoleMessage', { message: command });
  }

  async getConsoleUpdates(): Promise<AmpConsoleLine[]> {
    const out = await this.call<{ ConsoleEntries?: AmpConsoleLine[] }>('Core/GetUpdates');
    return out.ConsoleEntries ?? [];
  }
}

interface AmpStatusResponse {
  State?: number | string;
  Metrics?: Record<string, { RawValue?: number; MaxValue?: number; Percent?: number }>;
  Uptime?: string;
}

/** AMP ApplicationState enum (subset) -> normalized state. */
const AMP_STATE: Record<number, InstanceState> = {
  0: 'stopped', // Stopped
  5: 'starting', // PreStart / Configuring
  7: 'starting', // Starting
  10: 'running', // Ready
  15: 'restarting',
  20: 'stopping',
  30: 'stopping', // Sleeping treated as stopping-ish
  40: 'updating', // Installing/Updating
  45: 'updating',
};

function normalizeStatus(raw: AmpStatusResponse): InstanceStatus {
  let state: InstanceState = 'unknown';
  if (typeof raw.State === 'number') state = AMP_STATE[raw.State] ?? 'unknown';
  else if (typeof raw.State === 'string') {
    const s = raw.State.toLowerCase();
    state = (['running', 'stopped', 'starting', 'stopping', 'restarting', 'updating'] as const).find(
      (x) => s.includes(x),
    ) ?? 'unknown';
  }
  const cpu = raw.Metrics?.['CPU Usage']?.Percent ?? null;
  const memMetric = raw.Metrics?.['Memory Usage'];
  const memoryBytes = memMetric?.RawValue != null ? memMetric.RawValue * 1024 * 1024 : null;
  const memoryLimitBytes = memMetric?.MaxValue != null ? memMetric.MaxValue * 1024 * 1024 : null;
  const uptimeSeconds = parseUptime(raw.Uptime);
  return { state, cpuPercent: cpu, memoryBytes, memoryLimitBytes, uptimeSeconds, source: 'amp-api' };
}

function parseUptime(s?: string): number | null {
  if (!s) return null;
  // AMP uptime often like "1.02:03:04" (d.hh:mm:ss) or "02:03:04".
  const dm = s.match(/^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})/);
  if (!dm) return null;
  const [, d, h, m, sec] = dm;
  return (parseInt(d || '0', 10) * 86400) + parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(sec, 10);
}

export function buildAmpClient(): AmpApiClient | null {
  if (!env.ampConfigured) return null;
  return new AmpApiClient(env.AMP_BASE_URL!, env.AMP_USERNAME!, env.AMP_PASSWORD!);
}
