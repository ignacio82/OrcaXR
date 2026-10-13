import type { ProjectState } from '../project/domain/model';

/**
 * A project's shape for a diagnostics bundle (`ProjectSummaryInput`): counts
 * and names, never geometry. The workspace controller answers it from its
 * canonical state; the shared core answers the same from an export capture.
 */
export function diagnosticsProjectSummaryOf(state: ProjectState): {
  plateCount: number;
  objectCount: number;
  volumeCount: number;
  triangleCount: number;
  physicalFilamentCount: number;
  mixedFilamentCount: number;
  paintedVolumeCount: number;
  objectNames: string[];
} {
  const objects = state.plates.flatMap((plate) => plate.objects);
  const volumes = objects.flatMap((object) => object.volumes);
  return {
    plateCount: state.plates.length,
    objectCount: objects.length,
    volumeCount: volumes.length,
    triangleCount: volumes.reduce((total, volume) => total + volume.source.triangleCount, 0),
    physicalFilamentCount: state.filaments.physical.length,
    mixedFilamentCount: state.filaments.mixed.length,
    paintedVolumeCount: volumes.filter((volume) => volume.annotations.color.length > 0).length,
    objectNames: objects.map((object) => object.name),
  };
}
