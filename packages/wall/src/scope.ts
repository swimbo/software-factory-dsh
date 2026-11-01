/**
 * Path scope: what "inside the unit's declared blast radius" means.
 *
 * Lives in its own module (not in `evaluate.ts`) so the security-relevant path ladder
 * can reuse the exact same matcher without importing the decision module and creating a
 * cycle. Two different definitions of "in scope" — one for the scope check and one for
 * the security ladder — would be a way for a change to be simultaneously in scope and
 * outside it.
 */

function normalisePath(value: string): string {
  let path = value.replace(/\\/g, '/');
  while (path.startsWith('./')) path = path.slice(2);
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  return path;
}

/**
 * Turn a `touchPaths` entry into a matcher.
 *
 * Three forms, deliberately few: an exact path, a directory (trailing `/`, or a
 * bare path that also matches children), and a small glob (`*` within a segment,
 * `**` across segments). Anything more expressive would be a place for a parsing
 * bug to hide a scope violation.
 */
function touchPathMatches(path: string, touchPath: string): boolean {
  const target = normalisePath(touchPath);
  if (target === '') return false;
  if (target.includes('*')) {
    const pattern = new RegExp(`^${globToRegExpSource(target)}$`);
    return pattern.test(path);
  }
  if (path === target) return true;
  // A bare segment may name a directory; a file with the same prefix must not match.
  const prefix = target.endsWith('/') ? target : `${target}/`;
  return path.startsWith(prefix);
}

function globToRegExpSource(glob: string): string {
  let out = '';
  const meta = /[.+^${}()|[\]\\]/;
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob.charAt(i);
    if (ch === '*') {
      if (glob.charAt(i + 1) === '*') {
        out += '.*';
        i += 1;
        if (glob.charAt(i + 1) === '/') i += 1;
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += meta.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

/** Is every changed path inside the unit's declared blast radius? */
export function pathIsInScope(path: string, touchPaths: readonly string[]): boolean {
  const candidate = normalisePath(path);
  if (candidate === '' || candidate.startsWith('..') || isAbsoluteLike(candidate)) return false;
  // A `..` anywhere in the path is refused rather than resolved: `src/../etc/x`
  // would otherwise satisfy a `src/` prefix while living outside it. Diff paths
  // never legitimately contain `..`, so refusing is both safe and honest.
  if (candidate.split('/').includes('..')) return false;
  return touchPaths.some((touchPath) => touchPathMatches(candidate, touchPath));
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:\//.test(path);
}

export { normalisePath, touchPathMatches, globToRegExpSource, isAbsoluteLike };
