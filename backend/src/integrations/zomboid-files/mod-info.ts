/**
 * Parser for Project Zomboid `mod.info` files. These are simple key=value text
 * files shipped inside each mod folder. The authoritative Mod ID is the `id=`
 * value — this is what goes into the server's `Mods=` list, and it is NOT the
 * Steam Workshop ID. A single Workshop item can contain several mod folders,
 * each with its own `mod.info` (hence its own Mod ID).
 *
 * Example mod.info:
 *   name=Psychology Skill
 *   poster=poster.png
 *   id=psychology_skill
 *   description=Adds a psychology skill.
 *   author=SomeAuthor
 */

export interface ModInfo {
  id: string | null;
  name: string | null;
  author: string | null;
  poster: string | null;
}

// Conservative Mod ID format based on real mod.info `id=` values (letters,
// digits, underscore, dot, hyphen). No spaces / `;` / `/` / newlines / shell
// characters — safe to place in the semicolon-separated `Mods=` list and never
// usable as a filesystem path.
export const MOD_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

export function isValidModId(value: string): boolean {
  return MOD_ID_RE.test(value) && !value.includes('..') && value !== '.' && value !== '-';
}

export function parseModInfo(text: string): ModInfo {
  const info: ModInfo = { id: null, name: null, author: null, poster: null };
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!value) continue;
    switch (key) {
      case 'id':
        // First valid `id=` wins (some files list it once).
        if (info.id === null && isValidModId(value)) info.id = value;
        break;
      case 'name':
        if (info.name === null) info.name = value;
        break;
      case 'author':
        if (info.author === null) info.author = value;
        break;
      case 'poster':
        if (info.poster === null) info.poster = value;
        break;
    }
  }
  return info;
}
