/**
 * Consistent API error model. Every error surfaced to the browser has a stable
 * machine `code` and a safe human `message`. Stack traces are never sent.
 */
export type ErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'OPERATION_IN_PROGRESS'
  | 'SERVER_OFFLINE'
  | 'RCON_UNAVAILABLE'
  | 'AMP_UNAVAILABLE'
  | 'CONFIG_WRITE_FAILED'
  | 'PZ_RESPONSE_INVALID'
  | 'RATE_LIMITED'
  | 'NOT_SUPPORTED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  OPERATION_IN_PROGRESS: 409,
  SERVER_OFFLINE: 409,
  RCON_UNAVAILABLE: 503,
  AMP_UNAVAILABLE: 503,
  CONFIG_WRITE_FAILED: 500,
  PZ_RESPONSE_INVALID: 502,
  RATE_LIMITED: 429,
  NOT_SUPPORTED: 501,
  INTERNAL: 500,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** Optional non-secret context (never contains passwords/tokens). */
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }

  toPayload() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const err = {
  invalid: (m: string, d?: Record<string, unknown>) => new ApiError('INVALID_INPUT', m, d),
  unauthorized: (m = 'Authentication required.') => new ApiError('UNAUTHORIZED', m),
  forbidden: (m = 'You do not have permission to perform this action.') => new ApiError('FORBIDDEN', m),
  notFound: (m = 'Not found.') => new ApiError('NOT_FOUND', m),
  conflict: (m: string) => new ApiError('CONFLICT', m),
  busy: (m = 'Another server operation is already in progress.') => new ApiError('OPERATION_IN_PROGRESS', m),
  offline: (m = 'The server is not online.') => new ApiError('SERVER_OFFLINE', m),
  rcon: (m = 'Project Zomboid RCON is currently unavailable.') => new ApiError('RCON_UNAVAILABLE', m),
  amp: (m = 'The AMP instance is currently unavailable.') => new ApiError('AMP_UNAVAILABLE', m),
  configWrite: (m: string) => new ApiError('CONFIG_WRITE_FAILED', m),
  pzResponse: (m = 'The server returned an unexpected response.') => new ApiError('PZ_RESPONSE_INVALID', m),
  notSupported: (m: string) => new ApiError('NOT_SUPPORTED', m),
};
