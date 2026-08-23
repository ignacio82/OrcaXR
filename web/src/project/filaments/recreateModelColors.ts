/**
 * Headless model-color recreation and matching engine for OrcaXR.
 *
 * Slices distinct colors from loaded model objects, source materials, and facet
 * paint annotations, and finds the closest matching available physical filaments
 * or synthesizes Full-Spectrum dithering recipes via CIELAB DeltaE 2000 and the
 * pinned 330-coefficient pigment mixing model.
 */

import { cloneJson, compareCanonicalText } from '../domain/canonical';
import { remapFacetChannelValues } from '../domain/facetRefinement';
import type { FilamentId, PhysicalFilamentId, IdSource } from '../domain/ids';
import type { MixedFilament, PhysicalFilament, ProjectState } from '../domain/model';
import type { EditorSession } from '../session';
import {
  arePinnedFilamentCategoriesCompatible,
  classifyPinnedFilamentType,
  pinnedColorDeltaE2000,
  searchSuppliedPaletteColorMatch,
  type SuppliedPaletteMatchRecipe,
} from './colorMatchSearch';
import { SnapshotFilamentCommand, printerFilamentSlotName, type PrinterFilamentSlotFacts } from './commands';
import { createFullSpectrumMixedFilament, type FullSpectrumMatchDraft } from './fullSpectrumRecipe';

export interface ModelColorUsage {
  /** Normalized uppercase 6-digit hex color (#RRGGBB). */
  readonly color: string;
  /** Any canonical filament IDs that currently carry this color. */
  readonly sourceFilamentIds: readonly FilamentId[];
  /** Optional source material name from import metadata or filament preset. */
  readonly sourceMaterialName?: string;
  /** Sample entity names (objects / volumes) using this color. */
  readonly sampleNames: readonly string[];
  /** Total number of scene entities or facet annotations referencing this color. */
  readonly usageCount: number;
}

export type ModelColorMatchDestinationKind = 'physical' | 'existing-mixed' | 'new-mixed';

export interface ModelColorMatchDestination {
  readonly kind: ModelColorMatchDestinationKind;
  /** Stable filament ID if matching an existing physical or mixed filament. */
  readonly filamentId?: FilamentId;
  /** Display color of the matched filament or predicted blend (#RRGGBB). */
  readonly displayColor: string;
  /** Human-readable label for the matched filament or recipe. */
  readonly name: string;
  /** Perceptual color difference (DeltaE 2000) from the source color. */
  readonly deltaE2000: number;
  /** Draft recipe if a new Full-Spectrum mixed filament should be created. */
  readonly newRecipeDraft?: FullSpectrumMatchDraft;
}

export interface ModelColorMatchRow {
  readonly source: ModelColorUsage;
  readonly destination: ModelColorMatchDestination;
}

export interface RecreateModelColorsPlan {
  readonly matches: readonly ModelColorMatchRow[];
  readonly availablePhysicalCount: number;
  readonly canGenerateFullSpectrum: boolean;
  readonly averageDeltaE2000: number;
  readonly maxDeltaE2000: number;
  readonly sourceRevision: number;
  readonly sourceHash: string;
  readonly printerSlotsToAdopt?: readonly PrinterFilamentSlotFacts[];
  readonly candidatePhysicalFilaments?: readonly PhysicalFilament[];
}

export interface RecreateModelColorsOptions {
  readonly allowNewFullSpectrumRecipes?: boolean;
  readonly minComponentPercent?: number;
  readonly onlySelectedObjects?: boolean;
  readonly selectedObjectIds?: readonly string[];
  readonly printerSlots?: readonly PrinterFilamentSlotFacts[];
  readonly candidatePhysicalFilaments?: readonly PhysicalFilament[];
}

export class StaleRecreateModelColorsPlanError extends Error {
  override readonly name = 'StaleRecreateModelColorsPlanError';

  constructor() {
    super('Recreate model colors plan was prepared for a stale canonical project revision');
  }
}

/** Normalize hex color string to uppercase #RRGGBB. */
export function normalizeHexColor(color: string): string | null {
  const trimmed = color.trim();
  const match = /^#?([0-9a-fA-F]{6})$/.exec(trimmed);
  if (match) return `#${match[1].toUpperCase()}`;
  return null;
}

/** Extract distinct source colors from the project state. */
export function extractModelColorUsages(
  state: ProjectState,
  options?: { readonly selectedObjectIds?: readonly string[] },
): readonly ModelColorUsage[] {
  const physicalById = new Map<string, PhysicalFilament>(state.filaments.physical.map((f) => [f.id, f]));
  const mixedById = new Map<string, MixedFilament>(state.filaments.mixed.map((f) => [f.id, f]));

  const getFilamentColor = (id: FilamentId): string | null => {
    const phys = physicalById.get(id);
    if (phys) return normalizeHexColor(phys.color);
    const mix = mixedById.get(id);
    if (mix) return normalizeHexColor(mix.displayColor);
    return null;
  };

  const getFilamentName = (id: FilamentId): string | undefined => {
    return physicalById.get(id)?.name ?? mixedById.get(id)?.name;
  };

  interface IntermediateUsage {
    color: string;
    sourceFilamentIds: Set<FilamentId>;
    sourceMaterialName?: string;
    sampleNames: Set<string>;
    usageCount: number;
  }

  const usagesByColor = new Map<string, IntermediateUsage>();

  const recordColor = (
    rawColor: string | null | undefined,
    sourceFilamentId?: FilamentId,
    materialName?: string,
    entityName?: string,
    weight = 1,
  ): void => {
    if (!rawColor) return;
    const normalized = normalizeHexColor(rawColor);
    if (!normalized) return;

    let existing = usagesByColor.get(normalized);
    if (!existing) {
      existing = {
        color: normalized,
        sourceFilamentIds: new Set(),
        sourceMaterialName: materialName,
        sampleNames: new Set(),
        usageCount: 0,
      };
      usagesByColor.set(normalized, existing);
    }
    if (sourceFilamentId) existing.sourceFilamentIds.add(sourceFilamentId);
    if (materialName && !existing.sourceMaterialName) existing.sourceMaterialName = materialName;
    if (entityName) existing.sampleNames.add(entityName);
    existing.usageCount += weight;
  };

  const selectedSet = options?.selectedObjectIds ? new Set(options.selectedObjectIds) : null;

  for (const plate of state.plates) {
    for (const object of plate.objects) {
      if (selectedSet && !selectedSet.has(object.id)) continue;

      for (const volume of object.volumes) {
        const volumeName = volume.name || object.name;
        // Source material extension data (e.g. from 3MF / OBJ / AMF import or preserved model color)
        const sourceMaterial = volume.extensionData?.['orcaxr:sourceMaterial'] as
          { readonly color?: string; readonly name?: string } | undefined;
        if (sourceMaterial?.color) {
          recordColor(sourceMaterial.color, volume.filamentId ?? object.filamentId, sourceMaterial.name, volumeName, 1);
        } else if (volume.filamentId) {
          // Volume direct filament assignment
          const volColor = getFilamentColor(volume.filamentId);
          if (volColor) {
            recordColor(volColor, volume.filamentId, getFilamentName(volume.filamentId), volumeName, 1);
          }
        } else if (object.filamentId) {
          const objectFilamentColor = getFilamentColor(object.filamentId);
          if (objectFilamentColor) {
            recordColor(objectFilamentColor, object.filamentId, getFilamentName(object.filamentId), object.name, 1);
          }
        }

        // Color facet annotations
        if (volume.annotations.color) {
          const originalFacetColors = (volume.extensionData?.['orcaxr:originalFilamentColors'] ??
            (state as { extensionData?: Record<string, unknown> }).extensionData?.['orcaxr:originalFilamentColors']) as
            Record<string, string> | undefined;

          for (const assignment of volume.annotations.color) {
            const rawVal = String(assignment.value);
            const directHex = normalizeHexColor(rawVal);
            if (directHex) {
              recordColor(directHex, undefined, undefined, volumeName, assignment.triangles.length);
            } else {
              const origHex = originalFacetColors?.[rawVal];
              const filColor = (origHex ? normalizeHexColor(origHex) : null) ?? getFilamentColor(rawVal as FilamentId);
              if (filColor) {
                recordColor(
                  filColor,
                  rawVal as FilamentId,
                  getFilamentName(rawVal as FilamentId),
                  volumeName,
                  assignment.triangles.length,
                );
              }
            }
          }
        }
      }

      for (const range of object.layerRanges) {
        if (range.filamentId) {
          const rangeColor = getFilamentColor(range.filamentId);
          if (rangeColor) {
            recordColor(rangeColor, range.filamentId, getFilamentName(range.filamentId), object.name, 1);
          }
        }
      }
    }
  }

  const results: ModelColorUsage[] = [];
  for (const usage of usagesByColor.values()) {
    results.push({
      color: usage.color,
      sourceFilamentIds: Object.freeze(Array.from(usage.sourceFilamentIds)),
      sourceMaterialName: usage.sourceMaterialName,
      sampleNames: Object.freeze(Array.from(usage.sampleNames)),
      usageCount: usage.usageCount,
    });
  }

  // Stable deterministic sort by usage count descending, then hex color
  results.sort((a, b) => b.usageCount - a.usageCount || compareCanonicalText(a.color, b.color));
  return Object.freeze(results);
}

function formatRecipeComponentsName(recipe: SuppliedPaletteMatchRecipe, eligible: readonly PhysicalFilament[]): string {
  const parts = recipe.components.map((c) => {
    const phys = eligible[c.toolId - 1];
    const label = phys ? phys.name : `T${c.toolId}`;
    return `${c.weight}% ${label}`;
  });
  return parts.join(' + ');
}

/** Compute the color matching plan against available physical and mixed filaments. */
export function planRecreateModelColors(
  state: ProjectState,
  options: RecreateModelColorsOptions = {},
): RecreateModelColorsPlan {
  const sourceUsages = extractModelColorUsages(state, {
    selectedObjectIds: options.onlySelectedObjects ? options.selectedObjectIds : undefined,
  });

  let physicalFilaments: readonly PhysicalFilament[];
  let printerSlotsToAdopt: readonly PrinterFilamentSlotFacts[] | undefined;

  if (options.candidatePhysicalFilaments && options.candidatePhysicalFilaments.length > 0) {
    physicalFilaments = options.candidatePhysicalFilaments.filter((f) => f.enabled !== false);
  } else if (options.printerSlots && options.printerSlots.length > 0) {
    printerSlotsToAdopt = options.printerSlots;
    physicalFilaments = options.printerSlots.map((slot) => {
      const existing = state.filaments.physical.find((f) => f.toolId === slot.toolId);
      return {
        id: existing?.id ?? (`physical-filament-${slot.toolId + 1}` as PhysicalFilamentId),
        toolId: slot.toolId,
        name: printerFilamentSlotName(slot) || `Tool ${slot.toolId + 1}`,
        color: normalizeHexColor(slot.color) ?? slot.color,
        material: slot.material,
        ...(slot.vendor?.trim() ? { vendor: slot.vendor.trim() } : {}),
        config: { filament_type: slot.material },
        enabled: true,
      };
    });
  } else {
    physicalFilaments = state.filaments.physical.filter((f) => f.enabled !== false);
  }

  const mixedFilaments = state.filaments.mixed.filter((f) => f.enabled !== false);

  const eligiblePhysical = physicalFilaments.filter((f) => classifyPinnedFilamentType(f.material) !== null);

  const canGenerateFullSpectrum =
    options.allowNewFullSpectrumRecipes !== false &&
    eligiblePhysical.length >= 2 &&
    arePinnedFilamentCategoriesCompatible(
      classifyPinnedFilamentType(eligiblePhysical[0].material)!,
      classifyPinnedFilamentType(eligiblePhysical[1].material)!,
    );

  const matches: ModelColorMatchRow[] = [];

  for (const source of sourceUsages) {
    let bestDestination: ModelColorMatchDestination | null = null;

    // 1. Evaluate physical filaments
    for (const phys of physicalFilaments) {
      const physColor = normalizeHexColor(phys.color);
      if (!physColor) continue;
      const deltaE = pinnedColorDeltaE2000(source.color, physColor);
      if (!bestDestination || deltaE < bestDestination.deltaE2000) {
        bestDestination = {
          kind: 'physical',
          filamentId: phys.id,
          displayColor: physColor,
          name: `${phys.name} (T${phys.toolId + 1})`,
          deltaE2000: deltaE,
        };
      }
    }

    // 2. Evaluate existing mixed filaments
    for (const mixed of mixedFilaments) {
      const mixedColor = normalizeHexColor(mixed.displayColor);
      if (!mixedColor) continue;
      const deltaE = pinnedColorDeltaE2000(source.color, mixedColor);
      if (!bestDestination || deltaE < bestDestination.deltaE2000) {
        bestDestination = {
          kind: 'existing-mixed',
          filamentId: mixed.id,
          displayColor: mixedColor,
          name: mixed.name,
          deltaE2000: deltaE,
        };
      }
    }

    // 3. Evaluate Full-Spectrum recipe generation if multi-material mixing is available
    // and the nearest physical/existing match is not already nearly exact (deltaE > 1.0)
    if (canGenerateFullSpectrum && (!bestDestination || bestDestination.deltaE2000 > 1.0)) {
      const palette = eligiblePhysical.map((p) => ({
        color: normalizeHexColor(p.color) ?? p.color,
        filamentType: p.material,
      }));
      const searchResult = searchSuppliedPaletteColorMatch({
        palette,
        targetColor: source.color,
        minComponentPercent: options.minComponentPercent ?? 20,
      });

      if (searchResult.ok && searchResult.recipe) {
        const recipe = searchResult.recipe;
        const recipePreview = normalizeHexColor(recipe.previewColor) ?? recipe.previewColor;
        const recipeDeltaE = recipe.deltaE2000 ?? pinnedColorDeltaE2000(source.color, recipePreview);

        if (!bestDestination || recipeDeltaE < bestDestination.deltaE2000 - 0.2) {
          const components = recipe.components.map((c) => ({
            filamentId: eligiblePhysical[c.toolId - 1].id,
            weight: c.weight,
          }));

          const recipeName = `Match ${source.color} (${formatRecipeComponentsName(recipe, eligiblePhysical)})`;
          const draft: FullSpectrumMatchDraft = {
            mode: 'match',
            name: recipeName,
            displayColor: recipePreview,
            targetColor: source.color,
            minComponentPercent: options.minComponentPercent ?? 20,
            components,
          };

          bestDestination = {
            kind: 'new-mixed',
            displayColor: recipePreview,
            name: `Blend: ${formatRecipeComponentsName(recipe, eligiblePhysical)}`,
            deltaE2000: recipeDeltaE,
            newRecipeDraft: draft,
          };
        }
      }
    }

    if (bestDestination) {
      matches.push({
        source,
        destination: bestDestination,
      });
    }
  }

  const deltaEs = matches.map((m) => m.destination.deltaE2000);
  const averageDeltaE2000 = deltaEs.length > 0 ? deltaEs.reduce((a, b) => a + b, 0) / deltaEs.length : 0;
  const maxDeltaE2000 = deltaEs.length > 0 ? Math.max(...deltaEs) : 0;

  return Object.freeze({
    matches: Object.freeze(matches),
    availablePhysicalCount: physicalFilaments.length,
    canGenerateFullSpectrum,
    averageDeltaE2000,
    maxDeltaE2000,
    sourceRevision: 0,
    sourceHash: '',
    printerSlotsToAdopt,
    candidatePhysicalFilaments: Object.freeze(physicalFilaments),
  });
}

export interface RecreateModelColorsApplyMapping {
  readonly sourceColor: string;
  readonly destinationFilamentId: FilamentId;
  readonly sourceFilamentIds?: readonly FilamentId[];
}

export class RecreateModelColorsCommand extends SnapshotFilamentCommand {
  readonly type = 'recreate-model-colors';
  readonly label: string;

  constructor(
    private readonly mappings: readonly RecreateModelColorsApplyMapping[],
    private readonly newMixedFilaments: readonly MixedFilament[] = [],
    private readonly printerSlotsToAdopt?: readonly PrinterFilamentSlotFacts[],
    private readonly candidatePhysicalFilaments?: readonly PhysicalFilament[],
    private readonly ids?: IdSource,
  ) {
    super();
    this.label = mappings.length === 1 ? 'Recreate 1 model color' : `Recreate ${mappings.length} model colors`;
  }

  protected mutate(state: ProjectState): void {
    // 0. If printer slots need to be adopted, adopt them
    if (this.printerSlotsToAdopt && this.printerSlotsToAdopt.length > 0) {
      const byTool = new Map(state.filaments.physical.map((filament) => [filament.toolId, filament]));
      const candidateByTool = new Map(this.candidatePhysicalFilaments?.map((filament) => [filament.toolId, filament]));
      for (const slot of this.printerSlotsToAdopt) {
        const filament = byTool.get(slot.toolId);
        const name = printerFilamentSlotName(slot);
        const candidate = candidateByTool.get(slot.toolId);
        if (!filament) {
          const newId = candidate?.id ?? this.ids?.next<'physical-filament'>('physical-filament');
          if (!newId) continue;
          state.filaments.physical.push({
            id: newId,
            name: name || `Tool ${slot.toolId + 1}`,
            toolId: slot.toolId,
            material: slot.material,
            color: normalizeHexColor(slot.color) ?? slot.color,
            ...(slot.vendor?.trim() ? { vendor: slot.vendor.trim() } : {}),
            config: { filament_type: slot.material },
            enabled: true,
          });
          continue;
        }
        filament.color = normalizeHexColor(slot.color) ?? slot.color;
        filament.material = slot.material;
        filament.config.filament_type = slot.material;
        if (name) filament.name = name;
        if (slot.vendor?.trim()) filament.vendor = slot.vendor.trim();
      }
      state.filaments.physical.sort((left, right) => left.toolId - right.toolId);
      const highestTool = state.filaments.physical.reduce(
        (highest, filament) => Math.max(highest, filament.toolId),
        -1,
      );
      state.printer.toolCount = Math.max(state.printer.toolCount, highestTool + 1);
    }

    // 1. Add any newly synthesized mixed filaments
    for (const mixed of this.newMixedFilaments) {
      state.filaments.mixed.push(cloneJson(mixed));
    }

    // 2. Build color and filament replacement mappings
    const colorToDestination = new Map<string, FilamentId>();
    const sourceFilamentToDestination = new Map<FilamentId, FilamentId>();

    for (const mapping of this.mappings) {
      const normalizedColor = normalizeHexColor(mapping.sourceColor);
      if (normalizedColor) {
        colorToDestination.set(normalizedColor, mapping.destinationFilamentId);
      }
      if (mapping.sourceFilamentIds) {
        for (const sourceId of mapping.sourceFilamentIds) {
          if (sourceId !== mapping.destinationFilamentId) {
            sourceFilamentToDestination.set(sourceId, mapping.destinationFilamentId);
          }
        }
      }
    }

    // 3. Remap scene objects, volumes, and facet annotations
    for (const plate of state.plates) {
      if (plate.wipeTower?.filamentId) {
        const dest = sourceFilamentToDestination.get(plate.wipeTower.filamentId);
        if (dest) plate.wipeTower.filamentId = dest;
      }

      for (const object of plate.objects) {
        if (object.filamentId) {
          const dest = sourceFilamentToDestination.get(object.filamentId);
          if (dest) object.filamentId = dest;
        }

        for (const range of object.layerRanges) {
          if (range.filamentId) {
            const dest = sourceFilamentToDestination.get(range.filamentId);
            if (dest) range.filamentId = dest;
          }
        }

        for (const volume of object.volumes) {
          // Check volume source material color (e.g. from imported model)
          const sourceMaterial = volume.extensionData?.['orcaxr:sourceMaterial'] as
            { readonly color?: string; readonly name?: string } | undefined;
          if (sourceMaterial?.color) {
            const norm = normalizeHexColor(sourceMaterial.color);
            if (norm) {
              const matchedDest = colorToDestination.get(norm);
              if (matchedDest) {
                volume.filamentId = matchedDest;
              }
            }
          }

          // Check volume filament assignment
          if (volume.filamentId) {
            const dest = sourceFilamentToDestination.get(volume.filamentId);
            if (dest) volume.filamentId = dest;
          }

          // Remap facet color annotations and sub-facet refinement trees
          if (volume.annotations.color || volume.annotations.refinement?.color) {
            const originalFacetColors = (volume.extensionData?.['orcaxr:originalFilamentColors'] ??
              (state as { extensionData?: Record<string, unknown> }).extensionData?.[
                'orcaxr:originalFilamentColors'
              ]) as Record<string, string> | undefined;

            const remapped = remapFacetChannelValues(
              volume.annotations.color,
              volume.annotations.refinement?.color,
              (val) => {
                const valStr = String(val);
                // Check if value is a source filament ID
                const filDest = sourceFilamentToDestination.get(valStr as FilamentId);
                if (filDest) return filDest;
                // Check if original facet colors had a record for this filament ID
                const origColor = originalFacetColors?.[valStr];
                if (origColor) {
                  const origHex = normalizeHexColor(origColor);
                  if (origHex) {
                    const origDest = colorToDestination.get(origHex);
                    if (origDest) return origDest;
                  }
                }
                // Check if value is a hex color
                const hexNorm = normalizeHexColor(valStr);
                if (hexNorm) {
                  const colorDest = colorToDestination.get(hexNorm);
                  if (colorDest) return colorDest;
                }
                return val;
              },
            );

            volume.annotations.color = remapped.assignments;
            if (volume.annotations.refinement) {
              if (remapped.encoding) {
                volume.annotations.refinement.color = remapped.encoding;
              } else {
                delete volume.annotations.refinement.color;
                if (Object.keys(volume.annotations.refinement).length === 0) {
                  delete volume.annotations.refinement;
                }
              }
            }
          }
        }
      }
    }
  }
}

/** Execute a color recreation plan within a single atomic history transaction. */
export function executeRecreateModelColors(
  session: EditorSession,
  plan: RecreateModelColorsPlan,
  idSource: IdSource,
  overrides?: ReadonlyMap<string, FilamentId>,
): boolean {
  if (plan.matches.length === 0) return false;

  const currentSnapshot = session.project.getSnapshot();
  if (
    plan.sourceRevision !== 0 &&
    (currentSnapshot.revision !== plan.sourceRevision || currentSnapshot.hash !== plan.sourceHash)
  ) {
    throw new StaleRecreateModelColorsPlanError();
  }

  // Resolve candidate physical filaments with real unique IDs if adding new tools
  const existingPhysicalByTool = new Map(currentSnapshot.state.filaments.physical.map((f) => [f.toolId, f]));
  const candidateIdRemap = new Map<FilamentId, FilamentId>();
  const resolvedPhysicalCandidates: PhysicalFilament[] = [];

  for (const phys of plan.candidatePhysicalFilaments ?? currentSnapshot.state.filaments.physical) {
    const existing = existingPhysicalByTool.get(phys.toolId);
    if (existing) {
      resolvedPhysicalCandidates.push({
        ...phys,
        id: existing.id,
      });
      candidateIdRemap.set(phys.id, existing.id);
    } else {
      const newToolId = idSource.next<'physical-filament'>('physical-filament');
      resolvedPhysicalCandidates.push({
        ...phys,
        id: newToolId,
      });
      candidateIdRemap.set(phys.id, newToolId);
    }
  }

  const newMixedFilaments: MixedFilament[] = [];
  const mappings: RecreateModelColorsApplyMapping[] = [];

  for (const match of plan.matches) {
    const overriddenId = overrides?.get(match.source.color);
    if (overriddenId) {
      mappings.push({
        sourceColor: match.source.color,
        destinationFilamentId: overriddenId,
        sourceFilamentIds: match.source.sourceFilamentIds,
      });
      continue;
    }

    if (match.destination.kind === 'new-mixed' && match.destination.newRecipeDraft) {
      const newId = idSource.next('mixed-filament');
      const draftWithResolvedIds: FullSpectrumMatchDraft = {
        ...match.destination.newRecipeDraft,
        components: match.destination.newRecipeDraft.components.map((c) => ({
          ...c,
          filamentId: (candidateIdRemap.get(c.filamentId) ?? c.filamentId) as PhysicalFilamentId,
        })),
      };
      const mixed = createFullSpectrumMixedFilament(newId, resolvedPhysicalCandidates, draftWithResolvedIds);
      newMixedFilaments.push(mixed);
      mappings.push({
        sourceColor: match.source.color,
        destinationFilamentId: newId,
        sourceFilamentIds: match.source.sourceFilamentIds,
      });
    } else if (match.destination.filamentId) {
      const resolvedDestId = candidateIdRemap.get(match.destination.filamentId) ?? match.destination.filamentId;
      mappings.push({
        sourceColor: match.source.color,
        destinationFilamentId: resolvedDestId,
        sourceFilamentIds: match.source.sourceFilamentIds,
      });
    }
  }

  if (
    mappings.length === 0 &&
    newMixedFilaments.length === 0 &&
    (!plan.printerSlotsToAdopt || plan.printerSlotsToAdopt.length === 0)
  ) {
    return false;
  }

  const command = new RecreateModelColorsCommand(
    mappings,
    newMixedFilaments,
    plan.printerSlotsToAdopt,
    resolvedPhysicalCandidates,
    idSource,
  );
  session.execute(command);
  return true;
}
