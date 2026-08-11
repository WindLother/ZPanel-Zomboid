import { err } from './errors';

/**
 * Serializes lifecycle / mutating operations so incompatible commands cannot
 * race (start+stop, two restarts, config write during update, ...). One logical
 * server is guarded by one lock. Callers that require exclusivity acquire it;
 * an incompatible concurrent attempt fails fast with OPERATION_IN_PROGRESS.
 */
export type OperationKind =
  | 'start'
  | 'stop'
  | 'restart'
  | 'update'
  | 'save'
  | 'config-write';

export interface ActiveOperation {
  kind: OperationKind;
  actor: string;
  startedAt: number;
}

class OperationLock {
  private active: ActiveOperation | null = null;

  get current(): ActiveOperation | null {
    return this.active;
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * Run `fn` while holding the lock. Throws OPERATION_IN_PROGRESS if a
   * conflicting operation is already running.
   */
  async run<T>(kind: OperationKind, actor: string, fn: () => Promise<T>): Promise<T> {
    if (this.active) {
      throw err.busy(
        `Cannot ${kind}: a ${this.active.kind} operation is already in progress.`,
      );
    }
    this.active = { kind, actor, startedAt: Date.now() };
    try {
      return await fn();
    } finally {
      this.active = null;
    }
  }
}

export const operationLock = new OperationLock();
