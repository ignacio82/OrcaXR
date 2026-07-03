/**
 * Top-cover hint — web port of Android `TopCoverRule.kt` (Snapmaker fork
 * PR #284). Reads the merged profile's `requires_top_cover` coBools (comma-
 * or semicolon-separated "1"/"0"/"true" tokens) and, if any slot demands the
 * U1's magnetic top cover, surfaces a non-blocking amber hint.
 */

export type TopCoverResult =
  | { kind: 'ok' }
  | { kind: 'warning'; slots: number[]; message: string };

export function evaluateTopCover(profileConfig: Record<string, string>): TopCoverResult {
  const raw = profileConfig['requires_top_cover']?.trim();
  if (!raw) return { kind: 'ok' };
  const tokens = raw.split(/[,;]/).map((t) => t.trim()).filter((t) => t.length > 0);
  const flagged: number[] = [];
  tokens.forEach((v, i) => {
    if (v === '1' || v.toLowerCase() === 'true') flagged.push(i);
  });
  if (flagged.length === 0) return { kind: 'ok' };
  const slotsLabel = flagged.map((i) => `T${i + 1}`).join(', ');
  return {
    kind: 'warning',
    slots: flagged,
    message:
      `Filament on ${slotsLabel} benefits from the U1's magnetic top cover. ` +
      `Install it to avoid warping on ABS/ASA/PA/PC.`,
  };
}
