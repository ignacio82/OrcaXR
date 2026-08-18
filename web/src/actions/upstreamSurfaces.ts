/**
 * Where every upstream menu item went (P11.2, P0.1, P0.2).
 *
 * P11.2's acceptance asks that the P0 surface manifest have "no unclassified
 * item". The manifest already says which *task* owns each upstream leaf, which
 * is a plan-level answer; it does not say how an operator reaches the thing. So
 * 205 upstream menu items sat dispositioned to P11.2 and unanswered, and the
 * only way to know whether one of them existed here was to read the catalog and
 * guess at a label.
 *
 * This is the missing half: each upstream item is classified as one of five
 * things, and the classification is checked rather than asserted.
 *
 * - **action** — a local action reaches it. The action's own capability says
 *   whether it works; this only says the item is not missing.
 * - **panel** — reachable, but through a panel rather than a catalogued action.
 * - **container** — a submenu heading, not an item. Upstream's extractor records
 *   these alongside real entries and they must be named, not silently dropped.
 * - **adaptation** — deliberately different here, pointing at the register entry
 *   that explains the difference (P11.7).
 * - **absent** — not built, pointing at the task that would build it.
 *
 * The point of separating the last two is that they are different promises. An
 * adaptation says "this will not arrive"; an absence says "this has not arrived
 * yet". A classification that blurred them would let the gap list quietly shrink
 * by relabelling.
 */

import type { ActionRegistry } from './ActionRegistry';

export interface UpstreamSurfaceLeaf {
  readonly id: string;
  readonly label: string;
  readonly symbol?: string;
}

export type UpstreamSurfaceClassification =
  | { readonly kind: 'action'; readonly action: string }
  | { readonly kind: 'panel'; readonly where: string }
  | { readonly kind: 'container'; readonly note: string }
  | { readonly kind: 'adaptation'; readonly adaptation: string; readonly reason: string }
  | { readonly kind: 'absent'; readonly task: string; readonly reason: string };

export interface UpstreamSurfaceMap {
  readonly schemaVersion: number;
  readonly family: string;
  readonly mappings: Readonly<Record<string, UpstreamSurfaceClassification>>;
}

export interface UpstreamSurfaceAudit {
  readonly leaves: number;
  readonly keys: number;
  readonly byKind: Readonly<Record<string, number>>;
  /** Upstream items reached by a local action, and which one. */
  readonly reached: readonly { readonly key: string; readonly action: string }[];
  readonly problems: readonly string[];
}

/** The overlay key for a leaf: its declaring symbol and its label. */
export function surfaceKey(leaf: UpstreamSurfaceLeaf): string {
  return `${leaf.symbol ?? 'runtime'}::${leaf.label}`;
}

export function auditUpstreamSurfaces(
  leaves: readonly UpstreamSurfaceLeaf[],
  map: UpstreamSurfaceMap,
  registry: ActionRegistry,
  known: { readonly adaptations: ReadonlySet<string>; readonly tasks: ReadonlySet<string> },
): UpstreamSurfaceAudit {
  const problems: string[] = [];
  const byKind: Record<string, number> = {};
  const reached: { key: string; action: string }[] = [];
  const seen = new Set<string>();

  for (const leaf of leaves) {
    const key = surfaceKey(leaf);
    const entry = map.mappings[key];
    if (!entry) {
      problems.push(`${key} (${leaf.id}) is unclassified: every upstream menu item needs a disposition here`);
      continue;
    }
    seen.add(key);
  }

  for (const [key, entry] of Object.entries(map.mappings)) {
    byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
    // A stale entry is not harmless: it is a classification of something that no
    // longer exists upstream, and it would keep counting as coverage.
    if (!seen.has(key)) problems.push(`${key} classifies nothing in the manifest; upstream no longer has it`);
    switch (entry.kind) {
      case 'action': {
        const action = registry.get(entry.action);
        if (!action) {
          problems.push(`${key} points at unknown action ${entry.action}`);
          break;
        }
        reached.push({ key, action: entry.action });
        const surfaces = action.capability.surfaces;
        if (!surfaces.some((surface) => surface.startsWith('dom-'))) {
          problems.push(`${key} → ${entry.action} reaches no DOM surface`);
        }
        if (!surfaces.includes('command-palette')) {
          problems.push(`${key} → ${entry.action} is not in the command palette, so search cannot find it`);
        }
        // The XR rule, stated once: reachable in the headset, or withheld with a
        // reason. Silence is the only outcome refused.
        if (!surfaces.some((surface) => surface.startsWith('xr-')) && !action.xrUnsupportedReason) {
          problems.push(`${key} → ${entry.action} is absent from XR without saying why`);
        }
        break;
      }
      case 'adaptation': {
        if (!known.adaptations.has(entry.adaptation)) {
          problems.push(`${key} cites ${entry.adaptation}, which is not in the adaptation register`);
        }
        if (!entry.reason.trim()) problems.push(`${key} cites ${entry.adaptation} with no reason`);
        break;
      }
      case 'absent': {
        if (!known.tasks.has(entry.task)) {
          problems.push(`${key} is owed by ${entry.task}, which is not a task in the plan`);
        }
        if (!entry.reason.trim()) problems.push(`${key} is absent with no reason`);
        break;
      }
      case 'panel': {
        if (!entry.where.trim()) problems.push(`${key} claims a panel without naming it`);
        break;
      }
      case 'container': {
        if (!entry.note.trim()) problems.push(`${key} is a container with no note`);
        break;
      }
      default:
        problems.push(`${key} has an unknown classification kind`);
    }
  }

  return {
    leaves: leaves.length,
    keys: Object.keys(map.mappings).length,
    byKind,
    reached,
    problems,
  };
}

/** Adaptation ids the register defines, read from the plan's own table. */
export function adaptationIdsFrom(plan: string): Set<string> {
  return new Set([...plan.matchAll(/^\| `(ADAPT-\d+)` \|/gm)].map((match) => match[1]));
}

/** Task ids the plan defines, read from its own checkboxes. */
export function taskIdsFrom(plan: string): Set<string> {
  return new Set([...plan.matchAll(/^- \[[ ~x!]\] \*\*(P\d+(?:\.\d+)*) —/gm)].map((match) => match[1]));
}
