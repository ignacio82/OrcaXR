/**
 * A sliced program, indexed for reading (P11.2).
 *
 * Upstream has a G-code window and OrcaXR had no way to read its own output.
 * That matters more since calibration sweeps became generated programs: an
 * operator is asked to inspect a file before printing it, with nothing to
 * inspect it in.
 *
 * The whole design constraint is size. A small cube slices to about 14,500
 * lines and a real plate reaches hundreds of thousands; putting that into the
 * DOM freezes the tab, and truncating it silently means the operator reads a
 * program that is not the one they will print. So this indexes line offsets
 * once and hands out windows, and every count it reports is of the whole
 * document rather than of the window.
 */

/** One line, with the 1-based number an operator would cite. */
export interface GcodeLine {
  readonly number: number;
  readonly text: string;
}

export interface GcodeSearchResult {
  /** Line numbers that matched, in order. */
  readonly lineNumbers: readonly number[];
  /** True when the search stopped early; the count is then a lower bound. */
  readonly truncated: boolean;
}

/** Matches beyond this are not collected; a reader cannot use 10,000 hits. */
export const MAX_SEARCH_RESULTS = 500;

export class GcodeDocument {
  /** Byte offset of each line's start, so a window costs one slice. */
  private readonly offsets: number[];

  constructor(private readonly source: string) {
    const offsets = [0];
    for (let index = source.indexOf('\n'); index >= 0; index = source.indexOf('\n', index + 1)) {
      offsets.push(index + 1);
    }
    // A trailing newline produces a final empty entry that is not a line an
    // operator would count, so it is dropped rather than reported as line n+1.
    if (offsets.length > 1 && offsets[offsets.length - 1] >= source.length) offsets.pop();
    this.offsets = offsets;
  }

  get lineCount(): number {
    return this.offsets.length;
  }

  get byteLength(): number {
    return this.source.length;
  }

  /**
   * Lines `[from, from + count)`, 1-based and clamped.
   *
   * Clamped rather than throwing: a viewer scrolled to the end of a program
   * that has since been re-sliced shorter should show the end of the new one,
   * not an error.
   */
  window(from: number, count: number): readonly GcodeLine[] {
    if (!Number.isFinite(from) || !Number.isFinite(count) || count <= 0) return [];
    const start = Math.max(1, Math.min(Math.floor(from), this.lineCount));
    const end = Math.min(this.lineCount, start + Math.floor(count) - 1);
    const lines: GcodeLine[] = [];
    for (let number = start; number <= end; number += 1) {
      const begin = this.offsets[number - 1];
      const stop = number < this.lineCount ? this.offsets[number] - 1 : this.source.length;
      // The final line's slice runs to the end of the source, which still
      // carries its own terminator when the program ends with a newline — that
      // offset was dropped so it would not count as an extra line. Both the
      // newline and a CRLF carriage return come off here.
      const text = this.source.slice(begin, stop).replace(/\n$/, '').replace(/\r$/, '');
      lines.push({ number, text });
    }
    return lines;
  }

  /**
   * Line numbers containing `query`, case-insensitively.
   *
   * Bounded, and it says when it stopped. An unbounded search over a
   * half-million-line program blocks the tab for seconds, and a viewer that
   * reported "500 matches" without saying there are more would have an operator
   * believe they had seen them all.
   */
  search(query: string, limit = MAX_SEARCH_RESULTS): GcodeSearchResult {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return { lineNumbers: [], truncated: false };
    const lineNumbers: number[] = [];
    const haystack = this.source.toLowerCase();
    let cursor = haystack.indexOf(needle);
    while (cursor >= 0) {
      const number = this.lineAt(cursor);
      // A line matching twice is one result: an operator is looking for lines,
      // not occurrences.
      if (lineNumbers[lineNumbers.length - 1] !== number) lineNumbers.push(number);
      if (lineNumbers.length >= limit) return { lineNumbers, truncated: true };
      cursor = haystack.indexOf(needle, cursor + needle.length);
    }
    return { lineNumbers, truncated: false };
  }

  /** The 1-based line a byte offset falls on, by binary search. */
  lineAt(offset: number): number {
    let low = 0;
    let high = this.offsets.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.offsets[middle] <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  }
}
