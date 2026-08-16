/**
 * Island Settlers — the stray-backtick check.
 *
 * WHY THIS EXISTS. Several modules keep a stylesheet or a GLSL shader in a
 * template literal, and those literals carry long prose comments. A backtick
 * inside one of those comments ENDS THE LITERAL. What follows is parsed as
 * JavaScript, the module fails, and `main.js` swallows the failed import into a
 * stub — so the feature silently stops existing with no error anywhere.
 *
 * It has happened twice:
 *
 *   ui/ovpan.js      a backticked `zoomAt` in the CSS literal. The map stopped
 *                    existing; the whole overview panel was a stub.
 *   world/regionmark.js  a backticked `cell` in the fragment shader. `regions.js`
 *                    imports it, so BOTH stubbed out, and the island lost its
 *                    hex rims, its light walls and every resource standing on
 *                    it — shipped to production and to TestFlight.
 *
 * `node --check` does NOT catch it — it passed on both of the modules above —
 * because the truncated literal plus the prose that follows can still parse as
 * a script. An ESM import cannot be fooled that way, so that is the whole test:
 * import every module under src/ and report the ones that throw a SyntaxError.
 * The message points at the prose ("Unexpected identifier 'cell'") rather than
 * at the quote that caused it, so when this fires, go and look for a backtick
 * in the nearest template literal above the named identifier.
 *
 *   node tools/litcheck.mjs            # scan src/, exit 1 on a finding
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = walk(SRC);
let bad = 0;

for (const f of files) {
  const rel = relative(ROOT, f);
  // Does it actually import? A heuristic scan for the offending shape was
  // tried first and was too noisy to gate on — several literals legitimately
  // carry a comment. The import is not a heuristic: it either parses or it
  // does not, which is exactly the question.
  try {
    await import(pathToFileURL(f).href);
  } catch (e) {
    // Anything that is not a parse failure (a missing browser global, a THREE
    // import, a side effect wanting a DOM) is not what this is looking for.
    if (e instanceof SyntaxError) {
      console.log(`  BROKEN   ${rel}: ${e.message}`);
      bad++;
    }
  }
}

console.log(bad ? `\n${bad} module(s) fail to parse.` : `\n${files.length} modules parse.`);
process.exit(bad ? 1 : 0);
