/**
 * Whether a part is drawn — embossed text or an SVG part — over the shared
 * contract: what the Emboss and SVG part tools ask of the selected part to
 * decide whether applying re-cuts it rather than adding a new part. The Rust
 * core answers the same requests (`ProjectSession::drawn_part`).
 */
import type {
  ProjectDrawnPartReplyWire,
  ProjectDrawnPartRequestWire,
} from '../../../../contracts/generated/project-intents';
import { wireText, wireUnits } from '../annotations/FacetRegionExchange';
import type { VolumeId } from '../domain/ids';
import type { ProjectState } from '../domain/model';
import { findVolume } from '../domain/selectors';

/** What a part is drawn from: its text recipe, its drawing, either or neither. */
export interface DrawnPart {
  readonly text: boolean;
  readonly svg: boolean;
}

/** Part [volumeId]'s recipes in [state], or undefined when the project has no such part. */
export function drawnPart(state: ProjectState, volumeId: VolumeId): DrawnPart | undefined {
  const found = findVolume(state, volumeId);
  if (!found) return undefined;
  return { text: found.volume.embossText !== undefined, svg: found.volume.embossSvg !== undefined };
}

/** `DrawnPartRequest` → `DrawnPartReply`; an unknown part is refused. */
export function drawnPartWire(state: ProjectState, request: ProjectDrawnPartRequestWire): ProjectDrawnPartReplyWire {
  const volumeId = wireText(request.volumeId) as VolumeId;
  const part = drawnPart(state, volumeId);
  return part
    ? { part: { text: part.text, svg: part.svg } }
    : { refused: { message: wireUnits(`Volume ${volumeId} is not in this project`) } };
}
