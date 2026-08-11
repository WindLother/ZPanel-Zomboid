import net from 'node:net';
import { err } from '../../shared/errors';

/**
 * Minimal Source RCON (Valve) protocol client — the protocol Project Zomboid's
 * native RCON speaks. Packet layout (little-endian):
 *
 *   int32 length (of the rest) | int32 id | int32 type | body (utf8) | 0x00 0x00
 *
 * Types: 3 = AUTH, 2 = EXEC/AUTH_RESPONSE, 0 = RESPONSE_VALUE.
 *
 * Long responses (e.g. `help`) are split across several RESPONSE_VALUE packets.
 * We detect the end of a multi-packet response with the well-known trick of
 * sending a follow-up empty command and watching for its echo sentinel.
 */

const AUTH = 3;
const EXEC = 2;
const RESPONSE = 0;
const SENTINEL_ID = 0x7fffffff;

export interface RconClientOptions {
  host: string;
  port: number;
  password: string;
  timeoutMs?: number;
}

export class RconClient {
  private socket: net.Socket | null = null;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { chunks: string[]; resolve: (v: string) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private authResolve: ((ok: boolean) => void) | null = null;
  private readonly timeoutMs: number;

  constructor(private readonly opts: RconClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5000;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.opts.host, port: this.opts.port });
      socket.setNoDelay(true);
      const onError = (e: Error) => {
        cleanup();
        reject(err.rcon(`RCON connection failed: ${e.message}`));
      };
      const onConnect = async () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        socket.on('data', (d) => this.onData(d));
        socket.on('error', (e) => this.onSocketError(e));
        socket.on('close', () => this.onClose());
        try {
          await this.authenticate();
          resolve();
        } catch (e) {
          reject(e);
        }
      };
      const connectTimer = setTimeout(() => onError(new Error('timeout')), this.timeoutMs);
      const cleanup = () => {
        clearTimeout(connectTimer);
        socket.removeListener('connect', onConnect);
        socket.removeListener('error', onError);
      };
      socket.once('connect', () => {
        clearTimeout(connectTimer);
        onConnect();
      });
      socket.once('error', onError);
    });
  }

  private authenticate(): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.authResolve = null;
        reject(err.rcon('RCON authentication timed out.'));
      }, this.timeoutMs);
      this.authResolve = (ok: boolean) => {
        clearTimeout(timer);
        this.authResolve = null;
        if (ok) resolve();
        else reject(err.rcon('RCON authentication failed (bad password).'));
      };
      this.write(id, AUTH, this.opts.password);
    });
  }

  /** Execute a raw command line. The command string must already be validated. */
  exec(command: string): Promise<string> {
    if (!this.connected) return Promise.reject(err.rcon('RCON is not connected.'));
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(err.rcon('RCON command timed out.'));
      }, this.timeoutMs);
      this.pending.set(id, { chunks: [], resolve, reject, timer });
      this.write(id, EXEC, command);
      // Sentinel: an empty RESPONSE_VALUE that the server echoes after the real
      // (possibly multi-packet) response, marking the boundary.
      this.write(SENTINEL_ID, RESPONSE, '');
    });
  }

  private write(id: number, type: number, body: string): void {
    const payload = Buffer.from(body, 'utf8');
    const buf = Buffer.alloc(payload.length + 14);
    buf.writeInt32LE(payload.length + 10, 0);
    buf.writeInt32LE(id, 4);
    buf.writeInt32LE(type, 8);
    payload.copy(buf, 12);
    buf.writeInt16LE(0, 12 + payload.length);
    this.socket?.write(buf);
  }

  private onData(data: Buffer): void {
    this.buf = Buffer.concat([this.buf, data]);
    // Frame packets: [int32 len][len bytes].
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readInt32LE(0);
      if (this.buf.length < 4 + len) return;
      const frame = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: Buffer): void {
    const id = frame.readInt32LE(0);
    const type = frame.readInt32LE(4);
    const body = frame.subarray(8, Math.max(8, frame.length - 2)).toString('utf8');

    // Auth response: id === request id on success, -1 on failure.
    if (this.authResolve && (type === EXEC || type === AUTH)) {
      this.authResolve(id !== -1);
      return;
    }

    if (id === SENTINEL_ID) {
      // Boundary marker: the most recent still-pending command is complete.
      const openId = [...this.pending.keys()].sort((a, b) => a - b)[0];
      if (openId !== undefined) {
        const p = this.pending.get(openId)!;
        clearTimeout(p.timer);
        this.pending.delete(openId);
        p.resolve(p.chunks.join(''));
      }
      return;
    }

    const p = this.pending.get(id);
    if (p) p.chunks.push(body);
  }

  private onSocketError(e: Error): void {
    this.failAll(err.rcon(`RCON socket error: ${e.message}`));
  }

  private onClose(): void {
    this.failAll(err.rcon('RCON connection closed.'));
    this.socket = null;
  }

  private failAll(e: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    if (this.authResolve) this.authResolve(false);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
  }
}
