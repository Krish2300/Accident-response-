/**
 * Post-generation repair for the Prisma client.
 *
 * The Prisma generator on this machine writes its output using the system ANSI
 * code page rather than UTF-8, which mangles every non-ASCII byte in the
 * generated files (its own doc header plus anything copied from the schema
 * comments). The result is a syntactically invalid `index.d.ts` and a broken
 * inline schema string in `index.js`.
 *
 * This script rewrites the generated artefacts with ASCII-only text. It is
 * idempotent and safe to run after every `prisma generate`.
 *
 * Note: the schema itself is also kept ASCII-only, which removes the need for
 * this in the common case; the repair script exists as a safety net.
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const REPLACEMENTS = new Map([
  ['─', '-'],
  ['━', '-'],
  ['═', '='],
  ['│', '|'],
  ['—', '-'],
  ['–', '-'],
  ['’', "'"],
  ['‘', "'"],
  ['“', '"'],
  ['”', '"'],
  ['·', '-'],
  ['±', '+/-'],
  ['\u00a0', ' '],
]);

const candidates = [
  join(process.cwd(), 'node_modules', '.prisma', 'client'),
  join(process.cwd(), 'node_modules', '@prisma', 'client'),
];

let repairedFiles = 0;
let repairedChars = 0;

for (const dir of candidates) {
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const ext = extname(name);
    if (!['.d.ts', '.js', '.mjs', '.ts'].includes(ext)) continue;
    const file = join(dir, name);
    const original = readFileSync(file, 'utf8');
    if (!/[^\x00-\x7F]/.test(original)) continue;

    let chars = 0;
    const repaired = [...original]
      .map((char) => {
        const code = char.codePointAt(0) ?? 0;
        if (code <= 0x7f) return char;
        chars += 1;
        return REPLACEMENTS.get(char) ?? '?';
      })
      .join('');

    writeFileSync(file, repaired, 'utf8');
    repairedFiles += 1;
    repairedChars += chars;
  }
}

if (repairedFiles > 0) {
  console.log(`[prisma-repair] rewrote ${repairedFiles} generated file(s), ${repairedChars} character(s) replaced.`);
}
