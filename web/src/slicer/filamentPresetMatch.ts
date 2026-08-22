/**
 * Bind a printer's reported filament slot to the filament preset that actually
 * describes it.
 *
 * The machine reports three separate facts — vendor, type, and its own finer
 * grade ("Matte", "SnapSpeed") — and only the type is a slicer material. Match
 * on the type alone and every PLA slot lands on whichever PLA preset the
 * catalog happens to list first, which is how four heads of Snapmaker PLA Matte
 * came back as four rows of Generic PLA. The grade is not a config key
 * anywhere: upstream encodes it in the preset name, so it is read back out of
 * the name here rather than invented as a new field.
 */

export interface ReportedFilamentSlot {
  /** The plain slicer material, such as PLA. */
  readonly material: string;
  /** The machine's finer grade, such as Matte or SnapSpeed. */
  readonly subType?: string;
  readonly vendor?: string;
}

export interface FilamentPresetCandidate<Id extends string = string> {
  readonly presetId: Id;
  /** Full preset name, `Snapmaker PLA Matte @U1` style. */
  readonly presetName: string;
  /** The preset's own `filament_type`. */
  readonly material: string;
  /** The preset's own `filament_vendor`, when it declares one. */
  readonly vendor?: string;
}

export interface FilamentPresetMatch<Id extends string = string> {
  readonly presetId: Id;
  readonly vendorMatched: boolean;
  readonly gradeMatched: boolean;
}

/** Comparison form: case- and separator-insensitive, so `Snap Speed` === `SnapSpeed`. */
function fold(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function words(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

/** The preset name without its `@printer` scope, which is not part of the identity. */
function presetHead(presetName: string): string {
  return presetName.split('@')[0].trim();
}

/**
 * The vendor a preset belongs to: its declared `filament_vendor`, or the
 * leading word of its name when the corpus leaves the key to a parent it does
 * not carry.
 */
export function filamentPresetVendor(candidate: FilamentPresetCandidate): string {
  const declared = candidate.vendor?.trim();
  if (declared) return declared;
  return words(presetHead(candidate.presetName))[0] ?? '';
}

/**
 * The grade a preset name carries beyond `<vendor> <material>` — `Matte` for
 * `Snapmaker PLA Matte @U1`, empty for the plain `Snapmaker PLA @U1`.
 *
 * Word-wise on purpose: `Snapmaker PLA-CF` also declares the material `PLA`,
 * and a prefix test would read its grade as `-CF` and offer it as a plain PLA.
 */
export function filamentPresetGrade(candidate: FilamentPresetCandidate): string {
  let remaining = words(presetHead(candidate.presetName));
  const vendor = words(filamentPresetVendor(candidate));
  if (vendor.length > 0 && vendor.every((word, index) => fold(remaining[index]) === fold(word))) {
    remaining = remaining.slice(vendor.length);
  }
  if (remaining.length > 0 && fold(remaining[0]) === fold(candidate.material)) {
    remaining = remaining.slice(1);
  }
  return remaining.join(' ');
}

/** Whether a candidate could be the slot's material at all. */
function materialMatches(candidate: FilamentPresetCandidate, slot: ReportedFilamentSlot): boolean {
  const wanted = fold(slot.material);
  return wanted.length > 0 && fold(candidate.material) === wanted;
}

/**
 * Whether every fact the printer reported is true of this preset.
 *
 * A fact the machine did not report is not a constraint: a slot that reports no
 * grade must not drag a deliberately chosen Silk preset back to the plain one.
 */
export function filamentPresetAgreesWithSlot(candidate: FilamentPresetCandidate, slot: ReportedFilamentSlot): boolean {
  if (!materialMatches(candidate, slot)) return false;
  const vendor = fold(slot.vendor);
  if (vendor && fold(filamentPresetVendor(candidate)) !== vendor) return false;
  const grade = fold(slot.subType);
  if (grade && fold(filamentPresetGrade(candidate)) !== grade) return false;
  return true;
}

/**
 * The best preset for a reported slot, or undefined when nothing declares that
 * material at all — an unmatched slot is reported, never bound to a guess.
 *
 * Ranking, strongest first: the vendor the machine named, then the exact grade
 * it named (an unreported grade prefers the plain preset over any grade), then
 * the shortest and lexicographically first name so the choice is deterministic
 * whatever order the corpus was compiled in.
 */
export function matchFilamentPreset<Id extends string>(
  candidates: readonly FilamentPresetCandidate<Id>[],
  slot: ReportedFilamentSlot,
): FilamentPresetMatch<Id> | undefined {
  const wantedVendor = fold(slot.vendor);
  const wantedGrade = fold(slot.subType);
  let best: { candidate: FilamentPresetCandidate<Id>; score: number; vendor: boolean; grade: boolean } | undefined;
  for (const candidate of candidates) {
    if (!materialMatches(candidate, slot)) continue;
    const vendorMatched = wantedVendor.length > 0 && fold(filamentPresetVendor(candidate)) === wantedVendor;
    const presetGrade = fold(filamentPresetGrade(candidate));
    const gradeMatched = presetGrade === wantedGrade;
    const score = (vendorMatched ? 8 : 0) + (gradeMatched ? 4 : 0) + (presetGrade.length === 0 ? 1 : 0);
    if (
      !best ||
      score > best.score ||
      (score === best.score && shorterName(candidate.presetName, best.candidate.presetName))
    ) {
      best = { candidate, score, vendor: vendorMatched, grade: gradeMatched };
    }
  }
  if (!best) return undefined;
  return Object.freeze({
    presetId: best.candidate.presetId,
    vendorMatched: best.vendor,
    gradeMatched: best.grade,
  });
}

function shorterName(left: string, right: string): boolean {
  if (left.length !== right.length) return left.length < right.length;
  return left.localeCompare(right, 'en-US') < 0;
}
