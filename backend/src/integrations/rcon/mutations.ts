/**
 * Honest result model for RCON mutations. Project Zomboid's RCON does not return
 * a machine-readable acknowledgement, so we combine two signals:
 *
 *   accepted   - the server did not reject the command (parsed from the reply).
 *   confirmed  - an authoritative source verified the effect (players list /
 *                servertest.db). Absent for commands with no queryable state.
 *
 * A command is NEVER reported as a blind `{ ok: true }`. When confirmation is
 * impossible we return `{ accepted, confirmed: false, confirmation: 'unavailable' }`.
 *
 * Rejection phrases below were captured from the live Build 42 server, e.g.:
 *   kickuser   -> "User X doesn't exist."
 *   additem    -> "No such user"
 *   addvehicle -> 'User "X" not found'
 *   powers     -> "User X not found."
 */

export type Confirmation = 'verified' | 'unconfirmed' | 'unavailable' | 'rejected';

export interface MutationResult {
  accepted: boolean;
  confirmed: boolean;
  confirmation: Confirmation;
  message?: string;
}

const REJECTION = /(does(?:n't| not) exist|no such user|not found|unknown command|invalid)/i;

export function interpretMutationAck(raw: string): { accepted: boolean; message: string } {
  const message = raw.trim();
  return { accepted: !REJECTION.test(message), message };
}

/**
 * Turn a raw RCON reply into a MutationResult. If accepted and a `verify`
 * function is supplied, it is run to confirm the effect against authoritative
 * state; otherwise the result is honestly `unavailable`.
 */
export async function resolveMutation(raw: string, verify?: () => Promise<boolean>): Promise<MutationResult> {
  const { accepted, message } = interpretMutationAck(raw);
  if (!accepted) return { accepted: false, confirmed: false, confirmation: 'rejected', message };
  if (!verify) return { accepted: true, confirmed: false, confirmation: 'unavailable', message };
  const confirmed = await verify();
  return { accepted: true, confirmed, confirmation: confirmed ? 'verified' : 'unconfirmed', message };
}
