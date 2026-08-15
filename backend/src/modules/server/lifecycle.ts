import crypto from 'node:crypto';
import { runtime } from '../../integrations/runtime';
import { rcon } from '../../integrations/rcon/service';
import { rconCommands } from '../../integrations/rcon/commands';
import { db } from '../../db';
import { operationLock } from '../../shared/lock';
import { logger } from '../../shared/logger';
import * as audit from '../activity/service';
import type { Role } from '../auth/service';

/**
 * Lifecycle operations, serialized through the operation lock so incompatible
 * actions cannot race. Stops/restarts are graceful: broadcast (optional) ->
 * save world via RCON -> ask the runtime adapter to stop/restart. We never issue
 * `kill`. Runtimes without lifecycle support reject with NOT_SUPPORTED.
 */

export interface ActorCtx {
  actorId: number | null;
  actorName: string;
  /** The actor's own panel role, carried into the audit row (never inferred). */
  actorRole?: Role | null;
  sourceIp: string;
}

async function trySave(): Promise<void> {
  try {
    await rcon.exec(rconCommands.save());
  } catch (e) {
    logger.warn({ err: (e as Error).message }, 'pre-stop world save failed; continuing');
  }
}

async function tryBroadcast(message: string): Promise<void> {
  try {
    await rcon.exec(rconCommands.servermsg(message));
  } catch {
    /* server may already be down / no players */
  }
}

export async function start(ctx: ActorCtx): Promise<void> {
  await operationLock.run('start', ctx.actorName, async () => {
    await runtime.start();
    audit.record({ ...ctx, action: 'server.start', success: true });
  });
}

export async function stop(ctx: ActorCtx, opts: { broadcast?: string } = {}): Promise<void> {
  await operationLock.run('stop', ctx.actorName, async () => {
    if (opts.broadcast) await tryBroadcast(opts.broadcast);
    await trySave();
    await runtime.stop();
    audit.record({ ...ctx, action: 'server.stop', success: true });
  });
}

export async function restart(ctx: ActorCtx, opts: { broadcast?: string } = {}): Promise<void> {
  await operationLock.run('restart', ctx.actorName, async () => {
    if (opts.broadcast) await tryBroadcast(opts.broadcast);
    await trySave();
    await runtime.restart();
    audit.record({ ...ctx, action: 'server.restart', success: true });
  });
}

export async function update(ctx: ActorCtx): Promise<void> {
  await operationLock.run('update', ctx.actorName, async () => {
    await trySave();
    await runtime.update();
    audit.record({ ...ctx, action: 'server.update', success: true });
  });
}

// --- Scheduled restart ------------------------------------------------------

const timers = new Map<string, NodeJS.Timeout>();

export interface ScheduledOp {
  id: string;
  kind: string;
  runAt: string;
  actorName: string;
  status: string;
}

export function scheduleRestart(ctx: ActorCtx, delayMinutes: number, broadcastMsg?: string): ScheduledOp {
  const id = crypto.randomBytes(8).toString('hex');
  const runAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  db.prepare(
    'INSERT INTO scheduled_ops (id, kind, run_at, payload, actor_name, status, created_at) VALUES (?,?,?,?,?,?,?)',
  ).run(
    id,
    'restart',
    runAt,
    JSON.stringify({
      broadcast: broadcastMsg ?? null,
      actorId: ctx.actorId,
      actorRole: ctx.actorRole ?? null,
      sourceIp: ctx.sourceIp,
    }),
    ctx.actorName,
    'pending',
    new Date().toISOString(),
  );
  armTimer(id, delayMinutes * 60_000);
  audit.record({ ...ctx, action: 'server.restart.schedule', details: { delayMinutes }, success: true });
  return { id, kind: 'restart', runAt, actorName: ctx.actorName, status: 'pending' };
}

function armTimer(id: string, ms: number): void {
  const t = setTimeout(() => void fire(id), Math.max(0, ms));
  timers.set(id, t);
}

async function fire(id: string): Promise<void> {
  timers.delete(id);
  const row = db.prepare('SELECT * FROM scheduled_ops WHERE id = ? AND status = ?').get(id, 'pending') as
    | { id: string; payload: string; actor_name: string }
    | undefined;
  if (!row) return;
  const payload = JSON.parse(row.payload || '{}');
  const ctx: ActorCtx = {
    actorId: payload.actorId ?? null,
    actorName: row.actor_name,
    actorRole: payload.actorRole ?? null,
    sourceIp: payload.sourceIp ?? '',
  };
  db.prepare('UPDATE scheduled_ops SET status = ? WHERE id = ?').run('running', id);
  try {
    await restart(ctx, { broadcast: payload.broadcast ?? 'Server is restarting now.' });
    db.prepare('UPDATE scheduled_ops SET status = ? WHERE id = ?').run('done', id);
  } catch (e) {
    logger.error({ err: (e as Error).message, id }, 'scheduled restart failed');
    db.prepare('UPDATE scheduled_ops SET status = ? WHERE id = ?').run('failed', id);
  }
}

export function cancelScheduled(id: string): boolean {
  const t = timers.get(id);
  if (t) {
    clearTimeout(t);
    timers.delete(id);
  }
  const info = db.prepare('UPDATE scheduled_ops SET status = ? WHERE id = ? AND status = ?').run('cancelled', id, 'pending');
  return info.changes > 0;
}

export function listScheduled(): ScheduledOp[] {
  const rows = db
    .prepare("SELECT id, kind, run_at AS runAt, actor_name AS actorName, status FROM scheduled_ops WHERE status = 'pending' ORDER BY run_at")
    .all() as ScheduledOp[];
  return rows;
}

/** On boot, re-arm timers for any still-pending scheduled operations. */
export function resumeScheduled(): void {
  const rows = db.prepare("SELECT id, run_at FROM scheduled_ops WHERE status = 'pending'").all() as Array<{
    id: string;
    run_at: string;
  }>;
  for (const r of rows) {
    const ms = new Date(r.run_at).getTime() - Date.now();
    armTimer(r.id, ms);
    logger.info({ id: r.id, inMs: ms }, 'resumed scheduled restart');
  }
}
