/**
 * Poll a read until it satisfies `ok`, or the attempts are exhausted. Used to
 * confirm a mutation's effect against an authoritative source that may lag the
 * command by a moment (e.g. Project Zomboid flushing to servertest.db). Bounded
 * so request handlers never hang.
 */
export async function confirmWithRetry<T>(
  read: () => T | Promise<T>,
  ok: (v: T) => boolean,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? 4;
  const delayMs = opts.delayMs ?? 250;
  for (let i = 0; i < attempts; i++) {
    try {
      if (ok(await read())) return true;
    } catch {
      /* transient read failure — retry */
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}
