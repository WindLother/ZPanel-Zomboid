import { err } from '../../shared/errors';

/**
 * Safe, deterministic parser for Project Zomboid `*_SandboxVars.lua`. The file
 * is a single Lua table literal of scalar assignments and one level of nested
 * tables, interleaved with `--` line comments. We parse it WITHOUT eval/Function
 * into a flat map of dotted paths -> value, and remember the exact source span
 * of each value so writes can splice only the changed literals and preserve all
 * comments, ordering, formatting, and unknown fields.
 */

export type LuaScalar = number | boolean | string;

interface ScalarEntry {
  path: string;
  value: LuaScalar;
  valueStart: number;
  valueEnd: number;
  type: 'int' | 'float' | 'bool' | 'string';
}

export interface ParsedSandbox {
  /** dotted path (e.g. "Zombies", "ZombieLore.Speed") -> parsed value */
  values: Record<string, LuaScalar>;
  /** internal entries with source spans, keyed by path */
  entries: Map<string, ScalarEntry>;
  source: string;
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;

class Cursor {
  pos = 0;
  constructor(readonly src: string) {}

  skipTrivia(): void {
    for (;;) {
      const c = this.src[this.pos];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.pos++;
      } else if (c === '-' && this.src[this.pos + 1] === '-') {
        // line comment (block comments not used by PZ SandboxVars)
        const nl = this.src.indexOf('\n', this.pos);
        this.pos = nl === -1 ? this.src.length : nl + 1;
      } else {
        return;
      }
    }
  }

  peek(): string {
    return this.src[this.pos];
  }

  readIdent(): string | null {
    IDENT.lastIndex = this.pos;
    const m = IDENT.exec(this.src);
    if (!m || m.index !== this.pos) return null;
    this.pos = IDENT.lastIndex;
    return m[0];
  }
}

function readValueLiteral(cur: Cursor): { raw: string; start: number; end: number } {
  cur.skipTrivia();
  const start = cur.pos;
  const src = cur.src;
  if (src[cur.pos] === '"' || src[cur.pos] === "'") {
    const quote = src[cur.pos];
    cur.pos++;
    while (cur.pos < src.length && src[cur.pos] !== quote) {
      if (src[cur.pos] === '\\') cur.pos++;
      cur.pos++;
    }
    cur.pos++; // closing quote
    return { raw: src.slice(start, cur.pos), start, end: cur.pos };
  }
  // number / boolean / bareword: read until terminator
  while (cur.pos < src.length && !/[,}\n\r]/.test(src[cur.pos])) cur.pos++;
  const end = cur.pos;
  return { raw: src.slice(start, end).trim(), start, end: start + src.slice(start, end).trimEnd().length };
}

function classify(raw: string): { value: LuaScalar; type: ScalarEntry['type'] } {
  if (raw === 'true') return { value: true, type: 'bool' };
  if (raw === 'false') return { value: false, type: 'bool' };
  if (/^".*"$/s.test(raw) || /^'.*'$/s.test(raw)) {
    return { value: raw.slice(1, -1), type: 'string' };
  }
  if (/^-?\d+$/.test(raw)) return { value: parseInt(raw, 10), type: 'int' };
  if (/^-?\d*\.\d+$/.test(raw) || /^-?\d+\.\d*$/.test(raw)) {
    return { value: parseFloat(raw), type: 'float' };
  }
  // Fallback: treat as string token.
  return { value: raw, type: 'string' };
}

function parseTable(cur: Cursor, prefix: string, entries: Map<string, ScalarEntry>): void {
  cur.skipTrivia();
  if (cur.peek() !== '{') throw err.pzResponse('SandboxVars: expected "{".');
  cur.pos++; // consume {
  for (;;) {
    cur.skipTrivia();
    const c = cur.peek();
    if (c === undefined) throw err.pzResponse('SandboxVars: unexpected end of file.');
    if (c === '}') {
      cur.pos++;
      return;
    }
    if (c === ',') {
      cur.pos++;
      continue;
    }
    const key = cur.readIdent();
    if (!key) throw err.pzResponse(`SandboxVars: expected identifier at offset ${cur.pos}.`);
    cur.skipTrivia();
    if (cur.peek() !== '=') throw err.pzResponse(`SandboxVars: expected "=" after ${key}.`);
    cur.pos++; // consume =
    cur.skipTrivia();
    const path = prefix ? `${prefix}.${key}` : key;
    if (cur.peek() === '{') {
      parseTable(cur, path, entries);
    } else {
      const { raw, start, end } = readValueLiteral(cur);
      const { value, type } = classify(raw);
      entries.set(path, { path, value, valueStart: start, valueEnd: end, type });
    }
  }
}

export function parseSandbox(text: string): ParsedSandbox {
  const cur = new Cursor(text);
  cur.skipTrivia();
  // Expect `SandboxVars = {`
  const ident = cur.readIdent();
  if (ident !== 'SandboxVars') throw err.pzResponse('SandboxVars: missing top-level table.');
  cur.skipTrivia();
  if (cur.peek() !== '=') throw err.pzResponse('SandboxVars: expected "=".');
  cur.pos++;
  const entries = new Map<string, ScalarEntry>();
  parseTable(cur, '', entries);
  const values: Record<string, LuaScalar> = {};
  for (const [path, e] of entries) values[path] = e.value;
  return { values, entries, source: text };
}

/** Serialize a JS value back to its Lua literal, matching the original type. */
function toLua(value: LuaScalar, type: ScalarEntry['type']): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return JSON.stringify(value); // safe double-quoted
  if (type === 'float') {
    return Number.isInteger(value) ? `${value}.0` : String(value);
  }
  return String(Math.trunc(value));
}

/**
 * Apply a patch (dotted path -> new value) by splicing only the changed value
 * literals into the original source. Unknown paths are rejected (callers only
 * pass keys they parsed). Everything else is preserved byte-for-byte.
 */
export function patchSandbox(parsed: ParsedSandbox, patch: Record<string, LuaScalar>): string {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (const [path, value] of Object.entries(patch)) {
    const entry = parsed.entries.get(path);
    if (!entry) throw err.invalid(`Unknown sandbox setting: ${path}`, { path });
    edits.push({ start: entry.valueStart, end: entry.valueEnd, text: toLua(value, entry.type) });
  }
  // Apply right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = parsed.source;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return out;
}
