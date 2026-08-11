import { z } from 'zod';
import { err } from './errors';

/**
 * Central input validation. Everything that could reach an RCON command, a file
 * write, or a database query is validated here against a strict allowlist of
 * shapes. User-supplied strings that end up inside a double-quoted RCON argument
 * must never contain a quote, backslash, or control character — Project Zomboid
 * has no escaping mechanism, so we reject rather than try to escape.
 */

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const RCON_UNSAFE = /["\\\x00-\x1f\x7f]/;

/** Assert a string is safe to place inside a quoted RCON argument. */
export function assertRconArg(value: string, field: string): string {
  if (RCON_UNSAFE.test(value)) {
    throw err.invalid(`${field} contains characters that are not allowed.`, { field });
  }
  return value;
}

// Project Zomboid usernames: letters/digits and a small set of separators.
// AllowNonAsciiUsername=false on this server, so ASCII only.
export const usernameSchema = z
  .string()
  .trim()
  .min(1, 'Username is required.')
  .max(32, 'Username is too long.')
  .regex(/^[A-Za-z0-9_.\- ]+$/, 'Username contains invalid characters.');

export const steamIdSchema = z
  .string()
  .trim()
  .regex(/^\d{17}$/, 'Steam64 IDs are exactly 17 digits.');

// Item identifiers look like `Base.Axe` or `Base.Bag_BigHikingBag`.
export const itemIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/, 'Item id must look like Module.Item, e.g. Base.Axe.');

// Vehicle scripts look like `Base.VanAmbulance`.
export const vehicleScriptSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+\.[A-Za-z0-9_]+$/, 'Vehicle script must look like Module.Vehicle.');

// Perk / skill names used by addxp, e.g. `Woodwork`, `Strength`.
export const perkSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .regex(/^[A-Za-z]+$/, 'Perk name must be alphabetic.');

export const itemCountSchema = z.coerce.number().int().min(1).max(1000);
export const xpAmountSchema = z.coerce.number().int().min(1).max(1_000_000);

export const broadcastSchema = z
  .string()
  .min(1, 'Message is required.')
  .max(400, 'Message is too long (max 400 characters).')
  .refine((s) => !CONTROL_CHARS.test(s), 'Message contains control characters.')
  .refine((s) => !s.includes('"'), 'Message may not contain double quotes.');

export const reasonSchema = z
  .string()
  .trim()
  .max(200, 'Reason is too long (max 200 characters).')
  .refine((s) => !RCON_UNSAFE.test(s), 'Reason contains characters that are not allowed.')
  .optional();
