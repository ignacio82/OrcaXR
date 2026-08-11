import { collapseFacetRefinementRoots } from '../domain/facetRefinement';
import type { FacetRefinementNode, JsonValue } from '../domain/model';

/**
 * Version 1 of the facet refinement encoding stored one root per source
 * triangle. Version 2 stores only the subdivided facets, because every other
 * root merely restated the sparse `TriangleAssignments` beside it — see
 * `ORCA_REFINEMENT_ENCODING_VERSION`.
 *
 * A project saved by an older build still carries the dense form, so it is
 * converted on read. The conversion is lossless in both directions: collapsing
 * re-derives exactly the assignments the dense roots implied, and the
 * subdivided facets are carried across untouched.
 */
export function migrateDenseFacetRefinements(state: unknown): number {
  let migrated = 0;
  for (const volume of eachVolume(state)) {
    const annotations = volume.annotations;
    if (!isRecord(annotations)) continue;
    const refinement = annotations.refinement;
    if (!isRecord(refinement)) continue;
    for (const channel of Object.keys(refinement)) {
      const encoding = refinement[channel];
      if (!isRecord(encoding) || !Array.isArray(encoding.roots)) continue;
      const collapsed = collapseFacetRefinementRoots(encoding.roots as readonly FacetRefinementNode<JsonValue>[]);
      // The dense roots were the authority for this channel, so its sparse
      // projection is replaced rather than merged: anything the two disagreed
      // about was already invalid.
      annotations[channel] = collapsed.assignments;
      if (collapsed.encoding) refinement[channel] = collapsed.encoding;
      else delete refinement[channel];
      migrated += 1;
    }
    if (Object.keys(refinement).length === 0) delete annotations.refinement;
  }
  return migrated;
}

function* eachVolume(state: unknown): Generator<Record<string, unknown>> {
  if (!isRecord(state) || !Array.isArray(state.plates)) return;
  for (const plate of state.plates) {
    if (!isRecord(plate) || !Array.isArray(plate.objects)) continue;
    for (const object of plate.objects) {
      if (!isRecord(object) || !Array.isArray(object.volumes)) continue;
      for (const volume of object.volumes) {
        if (isRecord(volume)) yield volume;
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
