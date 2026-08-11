/**
 * Generic server-runtime abstraction. The rest of the backend depends only on
 * this interface — never on AMP, ampinstmgr, systemd, docker, or any specific
 * lifecycle mechanism. Concrete adapters live alongside this file and are chosen
 * by server-side configuration (PZ_RUNTIME). This is what makes the product
 * usable both with and without AMP.
 */

export type RuntimeState =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'restarting'
  | 'updating'
  | 'unknown';

export interface RuntimeStatus {
  state: RuntimeState;
  /** Which mechanism produced this snapshot (e.g. 'amp-api', 'cli', 'proc'). */
  source: string;
}

export interface RuntimeMetrics {
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  uptimeSeconds: number | null;
  source: string;
}

/**
 * What a runtime can do. Surfaced to callers (and the audit/system endpoints)
 * so behavior degrades honestly instead of failing opaquely.
 *
 *  - durableServerSettings=false means the runtime may regenerate PZ config
 *    files (e.g. AMP rewrites servertest.ini from its own settings on restart),
 *    so panel writes to those files are not guaranteed durable across a restart.
 *    Configuration files remain a Project Zomboid concern; this is only a
 *    property of the runtime, not a config store.
 */
export interface RuntimeCapabilities {
  runtime: string;
  lifecycle: boolean;
  metrics: boolean;
  update: boolean;
  durableServerSettings: boolean;
}

export interface ServerRuntimeAdapter {
  readonly name: string;
  capabilities(): RuntimeCapabilities;
  getStatus(): Promise<RuntimeStatus>;
  getMetrics(): Promise<RuntimeMetrics>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  /** Optional — present only when capabilities().update is true. */
  update?(): Promise<void>;
  /** Cheap reachability probe for health endpoints. */
  healthy(): Promise<boolean>;
}
