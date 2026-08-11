import pino from 'pino';
import { env } from '../config/env';

/**
 * Structured logger. Secrets are redacted defensively: even if a password or
 * token is ever attached to a log object it is replaced with `[redacted]`.
 */
export const logger = pino({
  level: env.NODE_ENV === 'test' ? 'silent' : env.isProd ? 'info' : 'debug',
  redact: {
    paths: [
      'password',
      '*.password',
      'RCONPassword',
      '*.RCONPassword',
      'token',
      '*.token',
      'SESSION_SECRET',
      'AMP_PASSWORD',
      'PZ_RCON_PASSWORD',
      'headers.cookie',
      'headers.authorization',
      'req.headers.cookie',
    ],
    censor: '[redacted]',
  },
  transport: env.isProd
    ? undefined
    : { target: 'pino/file', options: { destination: 1 } },
});

export type Logger = typeof logger;
