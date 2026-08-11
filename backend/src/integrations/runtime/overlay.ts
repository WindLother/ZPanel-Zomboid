import { operationLock } from '../../shared/lock';
import type { RuntimeState } from './types';

/**
 * While a lifecycle operation is in progress, its intent wins over the observed
 * state so the UI reflects an in-flight action before process observation
 * catches up. Generic (operation-lock based) — applies to every runtime adapter.
 */
export function applyOperationOverlay(observed: RuntimeState): RuntimeState {
  const op = operationLock.current;
  if (!op) return observed;
  switch (op.kind) {
    case 'start':
      return 'starting';
    case 'stop':
      return 'stopping';
    case 'restart':
      return 'restarting';
    case 'update':
      return 'updating';
    default:
      return observed;
  }
}
