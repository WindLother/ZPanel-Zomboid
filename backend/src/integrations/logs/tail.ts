import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { paths } from '../../config/paths';
import { logger } from '../../shared/logger';

export interface LogEntry {
  time: string; // HH:MM:SS
  level: 'info' | 'warning' | 'error';
  text: string;
}

/**
 * Parse one Project Zomboid DebugLog line:
 *   [11-08-26 08:25:47.135] WARN : Category ... > message
 * Falls back gracefully for lines that do not match the canonical shape.
 */
export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.replace(/\r$/, '');
  if (!trimmed.trim()) return null;
  const m = trimmed.match(/^\[[^\]]*?(\d{2}:\d{2}:\d{2})[^\]]*\]\s*([A-Za-z]+)?\s*:?\s*(.*)$/);
  if (!m) return { time: '', level: 'info', text: trimmed };
  const [, time, rawLevel, rest] = m;
  const level = normalizeLevel(rawLevel);
  return { time, level, text: rest || trimmed };
}

function normalizeLevel(raw?: string): LogEntry['level'] {
  const l = (raw || '').toUpperCase();
  if (l.startsWith('ERR') || l === 'FATAL' || l === 'SEVERE') return 'error';
  if (l.startsWith('WARN')) return 'warning';
  return 'info';
}

async function newestDebugLog(): Promise<string | null> {
  let entries: string[];
  try {
    entries = await fsp.readdir(paths.logsDir);
  } catch {
    return null;
  }
  const candidates = entries.filter((f) => /DebugLog-server\.txt$/.test(f));
  if (candidates.length === 0) return null;
  // Filenames are timestamp-prefixed, so lexicographic max is the newest.
  candidates.sort();
  return path.join(paths.logsDir, candidates[candidates.length - 1]);
}

/**
 * Tails the newest DebugLog file, emitting parsed `entry` events. Reads only
 * appended bytes (tracks a byte offset), and switches files when the server
 * rotates to a new log on restart. Uses fs.watch (inotify) with a slow poll
 * safety net — it never re-reads the whole file on every tick.
 */
export class LogTailer extends EventEmitter {
  private file: string | null = null;
  private offset = 0;
  private partial = '';
  private watcher: fs.FSWatcher | null = null;
  private poll: NodeJS.Timeout | null = null;
  private reading = false;

  async start(): Promise<void> {
    this.file = await newestDebugLog();
    if (this.file) {
      try {
        this.offset = (await fsp.stat(this.file)).size; // stream new lines only
      } catch {
        this.offset = 0;
      }
    }
    try {
      this.watcher = fs.watch(paths.logsDir, () => void this.tick());
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'log dir watch failed; using poll only');
    }
    this.poll = setInterval(() => void this.tick(), 2000);
  }

  async recent(limit = 200): Promise<LogEntry[]> {
    const file = this.file ?? (await newestDebugLog());
    if (!file) return [];
    try {
      const stat = await fsp.stat(file);
      const readFrom = Math.max(0, stat.size - 128 * 1024);
      const fh = await fsp.open(file, 'r');
      try {
        const buf = Buffer.alloc(stat.size - readFrom);
        await fh.read(buf, 0, buf.length, readFrom);
        const lines = buf.toString('utf8').split('\n');
        if (readFrom > 0) lines.shift(); // drop partial first line
        return lines
          .map(parseLogLine)
          .filter((e): e is LogEntry => e !== null)
          .slice(-limit);
      } finally {
        await fh.close();
      }
    } catch {
      return [];
    }
  }

  private async tick(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      const newest = await newestDebugLog();
      if (newest && newest !== this.file) {
        // Rotation: start reading the new file from the beginning.
        this.file = newest;
        this.offset = 0;
        this.partial = '';
      }
      if (!this.file) return;
      const stat = await fsp.stat(this.file);
      if (stat.size < this.offset) {
        // File truncated/replaced in place.
        this.offset = 0;
        this.partial = '';
      }
      if (stat.size === this.offset) return;
      const fh = await fsp.open(this.file, 'r');
      try {
        const buf = Buffer.alloc(stat.size - this.offset);
        await fh.read(buf, 0, buf.length, this.offset);
        this.offset = stat.size;
        const chunk = this.partial + buf.toString('utf8');
        const lines = chunk.split('\n');
        this.partial = lines.pop() ?? '';
        for (const line of lines) {
          const entry = parseLogLine(line);
          if (entry) this.emit('entry', entry);
        }
      } finally {
        await fh.close();
      }
    } catch (e) {
      logger.debug({ err: (e as Error).message }, 'log tail tick failed');
    } finally {
      this.reading = false;
    }
  }

  stop(): void {
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
    this.watcher = null;
    this.poll = null;
    this.removeAllListeners();
  }
}

export const logTailer = new LogTailer();
