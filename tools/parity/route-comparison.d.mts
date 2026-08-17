/**
 * Types for the route comparator, so the web suite can drive it.
 *
 * The tool itself stays plain `.mjs` like the rest of `tools/parity`, which is
 * run by Node directly and never bundled. This declaration exists only so the
 * TypeScript suite that proves the comparator can import it without widening
 * anything to `any`.
 */

export interface ProgramSummary {
  readonly layers: number;
  readonly filamentMm: number | null;
  readonly roles: readonly string[];
  readonly commands: readonly string[];
  readonly extrudingMoves: number;
}

export function summariseProgram(gcode: string): ProgramSummary;

export function compareSummaries(
  left: ProgramSummary,
  right: ProgramSummary,
  options?: { readonly filamentTolerance?: number },
): readonly string[];

export function sliceWithCli(archivePath: string, cliPath: string): string;
