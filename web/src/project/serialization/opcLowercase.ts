import { CASED, EXPANSIONS, IGNORABLE, LOWER } from './opcCaseData';

function contains(ranges: readonly (readonly [number, number])[], cp: number): boolean {
  let lo = 0;
  let hi = ranges.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ranges[mid]![1] < cp) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length && ranges[lo]![0] <= cp;
}

function followingCased(input: string, index: number): boolean {
  while (index < input.length) {
    const cp = input.codePointAt(index)!;
    if (!contains(IGNORABLE, cp)) return contains(CASED, cp);
    index += cp > 0xffff ? 2 : 1;
  }
  return false;
}

function mapped(cp: number): string {
  for (const [source, expansion] of EXPANSIONS) {
    if (source === cp) return String.fromCodePoint(...expansion);
  }
  let lo = 0;
  let hi = LOWER.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (LOWER[mid]![1] < cp) lo = mid + 1;
    else hi = mid;
  }
  const row = LOWER[lo];
  if (row && cp >= row[0] && (cp - row[0]) % row[2] === 0) cp += row[3];
  return String.fromCodePoint(cp);
}

/** Unicode 16 default lowercase for persisted OPC declarations, independent of
 * the browser/OS Unicode version. Package names themselves remain unchanged.
 * Case-ignorable characters take precedence over Cased in Final_Sigma context.
 * Each following run is scanned at most once: sigma is not case-ignorable. */
export function opcLowercase(input: string): string {
  const output: string[] = [];
  let before = false;
  let index = 0;
  for (const char of input) {
    const cp = char.codePointAt(0)!;
    index += char.length;
    output.push(cp === 0x3a3 && before && !followingCased(input, index) ? '\u03c2' : mapped(cp));
    if (!contains(IGNORABLE, cp)) before = contains(CASED, cp);
  }
  return output.join('');
}
