import { env } from './config/env';
import { logger } from './shared/logger';
import { buildApp } from './app';
import './db'; // initialize panel database (side-effecting migrations)
import { sampleMetrics } from './modules/server/service';
import { logTailer } from './integrations/logs/tail';
import { resumeScheduled } from './modules/server/lifecycle';
import { cleanupSessions } from './modules/auth/service';
import { rcon } from './integrations/rcon/service';

async function main(): Promise<void> {
  const app = await buildApp();

  await logTailer.start();
  resumeScheduled();
  cleanupSessions();

  const metricsTimer = setInterval(() => void sampleMetrics(), env.METRICS_SAMPLE_MS);
  const sessionTimer = setInterval(() => cleanupSessions(), 60 * 60 * 1000);

  await app.listen({ host: env.HOST, port: env.PORT });
  logger.info(
    { host: env.HOST, port: env.PORT, ampMode: env.ampConfigured ? 'amp-api' : 'cli/proc' },
    'ZPanel backend listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    // Hard backstop: never let shutdown hang (e.g. a stuck connection) — exit
    // after a bounded grace period regardless.
    const kill = setTimeout(() => {
      logger.warn('shutdown grace elapsed; forcing exit');
      process.exit(0);
    }, 10_000);
    kill.unref();
    clearInterval(metricsTimer);
    clearInterval(sessionTimer);
    logTailer.stop();
    rcon.shutdown();
    try {
      await app.close();
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'error during app.close');
    }
    clearTimeout(kill);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((e) => {
  logger.error({ err: e }, 'failed to start');
  process.exit(1);
});
