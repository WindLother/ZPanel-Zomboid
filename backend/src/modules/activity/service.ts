import { db } from '../../db';

/**
 * Backend-authoritative audit log. Every meaningful administrative action is
 * recorded here (not in browser memory). Secrets must never be placed in
 * `details`.
 */
export interface AuditEvent {
  id: number;
  timestamp: string;
  actorId?: number | null;
  actorName: string;
  action: string;
  target?: string | null;
  details?: Record<string, unknown> | null;
  success: boolean;
  sourceIp?: string | null;
}

export interface RecordInput {
  actorId?: number | null;
  actorName: string;
  action: string;
  target?: string | null;
  details?: Record<string, unknown> | null;
  success: boolean;
  sourceIp?: string | null;
}

export function record(input: RecordInput): AuditEvent {
  const ts = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO audit (timestamp, actor_id, actor_name, action, target, details, success, source_ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      input.actorId ?? null,
      input.actorName,
      input.action,
      input.target ?? null,
      input.details ? JSON.stringify(input.details) : null,
      input.success ? 1 : 0,
      input.sourceIp ?? null,
    );
  return { id: Number(info.lastInsertRowid), timestamp: ts, ...input };
}

export function list(limit = 100): AuditEvent[] {
  const rows = db
    .prepare('SELECT * FROM audit ORDER BY id DESC LIMIT ?')
    .all(Math.min(limit, 500)) as Array<{
    id: number;
    timestamp: string;
    actor_id: number | null;
    actor_name: string;
    action: string;
    target: string | null;
    details: string | null;
    success: number;
    source_ip: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    timestamp: r.timestamp,
    actorId: r.actor_id,
    actorName: r.actor_name,
    action: r.action,
    target: r.target,
    details: r.details ? JSON.parse(r.details) : null,
    success: r.success === 1,
    sourceIp: r.source_ip,
  }));
}
