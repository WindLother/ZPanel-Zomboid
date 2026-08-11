import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../plugins/auth';
import { logTailer, type LogEntry } from '../../integrations/logs/tail';

/**
 * Logs: a bounded recent snapshot plus a Server-Sent Events stream for live
 * tailing (one-way server -> browser, so SSE rather than WebSocket). The stream
 * is fed by the shared LogTailer, which reads only appended bytes and follows
 * log rotation.
 */
export async function logsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/logs', { preHandler: requireAuth }, async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    return logTailer.recent(limit);
  });

  app.get('/api/logs/stream', { preHandler: requireAuth }, async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const send = (entry: LogEntry) => {
      reply.raw.write(`data: ${JSON.stringify(entry)}\n\n`);
    };
    logTailer.on('entry', send);

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      logTailer.off('entry', send);
    });

    // Keep the handler open; response ends when the client disconnects.
    return reply;
  });
}
