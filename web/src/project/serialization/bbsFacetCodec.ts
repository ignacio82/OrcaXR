import {
  ORCA_REFINEMENT_MAX_DEPTH,
  ORCA_REFINEMENT_MAX_NODES,
  type FacetRefinementNode,
  type FacetRefinementState,
  type JsonValue,
} from '../domain/model';

const HEX = '0123456789ABCDEF';
const MAX_BBS_FACET_STATE = 255;

export class BbsFacetCodecError extends Error {
  override readonly name = 'BbsFacetCodecError';
}

export interface BbsFacetDecodeBudget {
  remainingNodes: number;
}

/** Exact FacetsAnnotation::get_triangle_as_string projection for one source root. */
export function encodeBbsFacetRoot<T extends JsonValue>(
  root: FacetRefinementNode<T>,
  encodeAssigned: (value: T) => number,
): string {
  const output: string[] = [];
  const stack: Array<{ node: FacetRefinementNode<T>; depth: number } | { marker: number }> = [{ node: root, depth: 0 }];
  let nodeCount = 0;
  while (stack.length > 0) {
    const entry = stack.pop()!;
    if ('marker' in entry) {
      output.push(HEX[entry.marker]);
      continue;
    }
    const { node, depth } = entry;
    nodeCount += 1;
    if (nodeCount > ORCA_REFINEMENT_MAX_NODES) throw new BbsFacetCodecError('Facet tree exceeds the node limit');
    if (node.kind === 'leaf') {
      output.push(encodeState(node.state.kind === 'unpainted' ? 0 : encodeAssigned(node.state.value)));
      continue;
    }
    if (
      (node.splitSides !== 1 && node.splitSides !== 2 && node.splitSides !== 3) ||
      (node.specialSide !== 0 && node.specialSide !== 1 && node.specialSide !== 2) ||
      (node.splitSides === 3 && node.specialSide !== 0) ||
      !Array.isArray(node.children) ||
      node.children.length !== node.splitSides + 1
    ) {
      throw new BbsFacetCodecError('Facet tree contains an invalid split');
    }
    if (depth >= ORCA_REFINEMENT_MAX_DEPTH) throw new BbsFacetCodecError('Facet tree exceeds the depth limit');
    // Reverse(bitstream(node)) emits children 0..N followed by this marker.
    stack.push({ marker: (node.specialSide << 2) | node.splitSides });
    for (let child = node.children.length - 1; child >= 0; child -= 1) {
      stack.push({ node: node.children[child], depth: depth + 1 });
    }
  }
  return output.join('');
}

/** Strict inverse of encodeBbsFacetRoot; malformed/trailing/deep streams are rejected. */
export function decodeBbsFacetRoot<T extends JsonValue>(
  encoded: string,
  decodeAssigned: (state: number) => T | undefined,
  budget: BbsFacetDecodeBudget = { remainingNodes: ORCA_REFINEMENT_MAX_NODES },
): FacetRefinementNode<T> {
  if (!encoded || !/^[0-9A-F]+$/.test(encoded)) {
    throw new BbsFacetCodecError('Facet paint must use non-empty uppercase hex');
  }
  if (encoded.length > Math.max(1, budget.remainingNodes) * 18) {
    throw new BbsFacetCodecError('Facet paint exceeds the encoded size limit');
  }
  let cursor = encoded.length - 1;
  let nodeCount = 0;
  const next = (): number => {
    if (cursor < 0) throw new BbsFacetCodecError('Facet paint stream is truncated');
    return Number.parseInt(encoded[cursor--], 16);
  };
  const decodeNode = (depth: number): FacetRefinementNode<T> => {
    nodeCount += 1;
    budget.remainingNodes -= 1;
    if (nodeCount > ORCA_REFINEMENT_MAX_NODES || budget.remainingNodes < 0) {
      throw new BbsFacetCodecError('Facet tree exceeds the node limit');
    }
    const code = next();
    const splitSides = code & 3;
    if (splitSides === 0) {
      let state = code >> 2;
      if ((code & 0xc) === 0xc) {
        let extensions = 0;
        let extension = next();
        while (extension === 0xf) {
          extensions += 1;
          if (extensions > Math.ceil(MAX_BBS_FACET_STATE / 15)) {
            throw new BbsFacetCodecError('Facet paint state exceeds the pinned range');
          }
          extension = next();
        }
        state = 3 + extensions * 15 + extension;
      }
      if (state > MAX_BBS_FACET_STATE) throw new BbsFacetCodecError('Facet paint state exceeds the pinned range');
      if (state === 0) return { kind: 'leaf', state: { kind: 'unpainted' } };
      const value = decodeAssigned(state);
      if (value === undefined) throw new BbsFacetCodecError(`Facet paint state ${state} is invalid for this channel`);
      return { kind: 'leaf', state: { kind: 'assigned', value } };
    }
    if (depth >= ORCA_REFINEMENT_MAX_DEPTH) throw new BbsFacetCodecError('Facet tree exceeds the depth limit');
    const specialSide = code >> 2;
    if (specialSide > 2 || (splitSides === 3 && specialSide !== 0)) {
      throw new BbsFacetCodecError('Facet tree contains an invalid special side');
    }
    const children = Array<FacetRefinementNode<T>>(splitSides + 1);
    for (let child = splitSides; child >= 0; child -= 1) children[child] = decodeNode(depth + 1);
    return {
      kind: 'split',
      splitSides: splitSides as 1 | 2 | 3,
      specialSide: specialSide as 0 | 1 | 2,
      children,
    };
  };
  const root = decodeNode(0);
  if (cursor !== -1) throw new BbsFacetCodecError('Facet paint stream contains trailing data');
  return root;
}

export function unpaintedBbsFacetRoot<T extends JsonValue>(): FacetRefinementNode<T> {
  return { kind: 'leaf', state: { kind: 'unpainted' } };
}

export function assignedBbsFacetRoot<T extends JsonValue>(value: T): FacetRefinementNode<T> {
  return { kind: 'leaf', state: { kind: 'assigned', value } as FacetRefinementState<T> };
}

function encodeState(state: number): string {
  if (!Number.isInteger(state) || state < 0 || state > MAX_BBS_FACET_STATE) {
    throw new BbsFacetCodecError(`Facet paint state ${state} is outside 0..${MAX_BBS_FACET_STATE}`);
  }
  if (state <= 2) {
    return HEX[state << 2];
  }
  let extension = state - 3;
  let continuations = 0;
  while (extension >= 15) {
    continuations += 1;
    extension -= 15;
  }
  return `${HEX[extension]}${'F'.repeat(continuations)}C`;
}
