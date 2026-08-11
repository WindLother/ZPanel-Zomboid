/** Normalized instance state used across the backend. */
export type InstanceState =
  | 'running'
  | 'stopped'
  | 'starting'
  | 'stopping'
  | 'restarting'
  | 'updating'
  | 'unknown';

export interface InstanceStatus {
  state: InstanceState;
  cpuPercent: number | null;
  memoryBytes: number | null;
  memoryLimitBytes: number | null;
  uptimeSeconds: number | null;
  /** Which data source produced this snapshot: 'amp-api' | 'cli' | 'proc' | 'none'. */
  source: string;
}

export interface AmpConsoleLine {
  timestamp: string;
  source: string;
  type: string;
  text: string;
}
