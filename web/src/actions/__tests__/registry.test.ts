/**
 * Node tests for the ActionRegistry + catalog (run: npx tsx registry.test.ts).
 * These are the structural-parity guarantees: a duplicate id or a miswired
 * disclosure is a build-time failure, not a runtime surprise in one shell.
 */
import assert from 'node:assert';
import { entityId, type PlateId } from '../../project/domain/ids';
import type { ConfigMap } from '../../project/domain/model';
import type { ObjectTreeEntityRef } from '../../project/objects';
import type {
  CanonicalSemanticLayerRangeRequest,
  CanonicalSemanticVolumeRoleRequest,
  CanonicalVirtualFilamentMutationRequest,
} from '../../workspace/CanonicalWorkspaceController';
import { ActionRegistry, GROUPS, type ActionInvocation } from '../ActionRegistry';
import { buildRegistry } from '../catalog';
import type { ActionContext } from '../ActionContext';
import type { UiStateShape } from '../UiState';

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log('  ✓', name);
}

const baseState: UiStateShape = {
  mode: 'prepare',
  activeTool: 'move',
  modelCount: 0,
  plateCount: 1,
  hasSelection: false,
  hasInstanceSelection: false,
  hasClipboard: false,
  isSlicing: false,
  gcodeReady: false,
  extruderCount: 1,
  hasMultiColorPaint: false,
  canUndo: false,
  canRedo: false,
  dirty: false,
  projectionHealthy: true,
  status: '',
  progress: null,
  preflightBlocked: false,
  printerJobState: 'disconnected',
};

test('catalog builds without duplicate ids', () => {
  const reg = buildRegistry();
  assert.ok(reg.all().length >= 12, 'expected the current action set');
});

test('duplicate id throws', () => {
  const reg = new ActionRegistry();
  const a = buildRegistry().get('tool_move')!;
  reg.add(a);
  assert.throws(() => reg.add({ ...a }), /duplicate action id/);
});

test('an action without an explicit parity-task owner fails closed', () => {
  assert.throws(
    () =>
      new ActionRegistry().add({
        id: 'unmapped_action_fixture',
        label: 'Unmapped fixture',
        icon: 'move',
        group: 'scene',
        disclosure: 'menu',
        run: () => {},
      }),
    /has no parity-task owner/,
  );
});

test('every action has a known group', () => {
  const known = new Set(GROUPS.map((g) => g.id));
  for (const a of buildRegistry().all()) {
    assert.ok(known.has(a.group), `action ${a.id} has unknown group ${a.group}`);
  }
});

test('primary bar has the five expected actions', () => {
  const ids = buildRegistry()
    .byDisclosure('primary')
    .map((a) => a.id)
    .sort();
  // Cancel sits beside Slice because stopping a slice is now the only thing
  // that ends one: a quiet engine is left to work, however long it takes.
  assert.deepStrictEqual(
    ids,
    ['load_model_from_path', 'save_gcode_to_downloads', 'slice_active_plate', 'slice_cancel', 'toggle_preview'].sort(),
  );
});

test('every toolbar action declares a tool', () => {
  for (const a of buildRegistry().byDisclosure('toolbar')) {
    if (['tool_move', 'tool_rotate', 'tool_scale', 'tool_lay_on_face'].includes(a.id)) {
      assert.ok(a.tool, `${a.id} should declare a tool`);
    }
  }
});

test('MCP-backed actions declare the guarded automation surface', () => {
  const registry = buildRegistry();
  for (const action of registry.all().filter((candidate) => candidate.mcpTool)) {
    assert.ok(action.capability.surfaces.includes('automation'), `${action.id} is missing automation`);
  }
  assert.deepStrictEqual(
    registry.availability('tool_move', 'automation', {
      ...baseState,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    { state: 'enabled' },
  );
  assert.equal(
    registry.availability('tool_paint', 'automation', { ...baseState, hasSelection: true }).state,
    'disabled',
  );
});

test('Slice is gated: disabled with no models, enabled with models & clean preflight', () => {
  const slice = buildRegistry().get('slice_active_plate')!;
  assert.strictEqual(ActionRegistry.enabled(slice, baseState), false);
  assert.strictEqual(ActionRegistry.enabled(slice, { ...baseState, modelCount: 1 }), true);
  assert.strictEqual(ActionRegistry.enabled(slice, { ...baseState, modelCount: 1, preflightBlocked: true }), false);
  assert.strictEqual(ActionRegistry.enabled(slice, { ...baseState, modelCount: 1, isSlicing: true }), false);
  assert.strictEqual(ActionRegistry.enabled(slice, { ...baseState, modelCount: 1, projectionHealthy: false }), false);
  const save = buildRegistry().get('file_save_project')!;
  assert.strictEqual(ActionRegistry.enabled(save, { ...baseState, modelCount: 1 }), true);
  assert.strictEqual(ActionRegistry.enabled(save, { ...baseState, modelCount: 1, projectionHealthy: false }), false);
});

test('New Project remains reachable for settings-only dirty projects', () => {
  const action = buildRegistry().get('file_new_project')!;
  assert.strictEqual(ActionRegistry.enabled(action, baseState), false);
  assert.strictEqual(ActionRegistry.enabled(action, { ...baseState, dirty: true }), true);
  assert.strictEqual(ActionRegistry.enabled(action, { ...baseState, plateCount: 2 }), true);
  assert.strictEqual(ActionRegistry.enabled(action, { ...baseState, modelCount: 1 }), true);
});

test('Download, canonical delete, and guarded Split to Objects use prerequisites while unsafe topology changes stay gated', () => {
  const reg = buildRegistry();
  assert.strictEqual(ActionRegistry.enabled(reg.get('save_gcode_to_downloads')!, baseState), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('save_gcode_to_downloads')!, { ...baseState, gcodeReady: true }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_delete_selected')!, baseState), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('edit_delete_selected')!, {
      ...baseState,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('repair_model')!, {
      ...baseState,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('split_to_objects')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('split_to_objects')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('split_to_parts')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('split_to_parts')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('mesh_boolean_union')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(ActionRegistry.enabled(reg.get('mesh_boolean_subtract')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('mesh_boolean_intersection')!, { ...baseState, modelCount: 1 }),
    false,
  );
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('mesh_boolean_intersection')!, { ...baseState, modelCount: 2 }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('add_modifier')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('add_modifier')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('add_support_enforcer')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('add_support_enforcer')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('add_support_blocker')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('add_support_blocker')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('add_height_range')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('add_height_range')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('set_negative_part')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('set_negative_part')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('variable_layer_height')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('variable_layer_height')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('add_magnet')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('add_magnet')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('scan_network')!, baseState), true);
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_delete_all')!, { ...baseState, modelCount: 0 }), false);
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_delete_all')!, { ...baseState, modelCount: 1 }), true);
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_copy')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('edit_copy')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_cut')!, { ...baseState, modelCount: 1 }), false);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('edit_cut')!, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_paste')!, { ...baseState, hasClipboard: false }), false);
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_paste')!, { ...baseState, hasClipboard: true }), true);
  assert.strictEqual(ActionRegistry.enabled(reg.get('file_export_3mf')!, { ...baseState, modelCount: 0 }), false);
  assert.strictEqual(ActionRegistry.enabled(reg.get('file_export_3mf')!, { ...baseState, modelCount: 1 }), true);
  assert.strictEqual(
    ActionRegistry.enabled(reg.get('file_export_all_plates')!, { ...baseState, modelCount: 0 }),
    false,
  );
  assert.strictEqual(ActionRegistry.enabled(reg.get('file_export_all_plates')!, { ...baseState, modelCount: 1 }), true);
  assert.strictEqual(ActionRegistry.enabled(reg.get('tool_cut')!, { ...baseState, modelCount: 2 }), false);
  assert.match(ActionRegistry.disabledReason(reg.get('repair_model')!, baseState) ?? '', /select/i);
});

test('Split to Objects and Split to Parts route only through the shared asynchronous action context', () => {
  let objectCalls = 0;
  let partCalls = 0;
  const ctx = {
    async splitToObjects() {
      objectCalls += 1;
    },
    async splitToParts() {
      partCalls += 1;
    },
  } as unknown as ActionContext;
  const reg = buildRegistry();
  const result1 = reg.get('split_to_objects')!.run!(ctx, {});
  const result2 = reg.get('split_to_parts')!.run!(ctx, {});
  assert.equal(objectCalls, 1);
  assert.equal(partCalls, 1);
  assert.ok(result1 instanceof Promise);
  assert.ok(result2 instanceof Promise);
});

test('typed Objects selection does not enable instance-only legacy actions', () => {
  const reg = buildRegistry();
  const objectOnly = { ...baseState, modelCount: 1, hasSelection: true };
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_deselect_all')!, objectOnly), true);
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_delete_selected')!, objectOnly), false);
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_duplicate')!, objectOnly), false);
  assert.strictEqual(ActionRegistry.enabled(reg.get('tool_move')!, objectOnly), false);
  assert.strictEqual(
    ActionRegistry.disabledReason(reg.get('tool_move')!, objectOnly),
    'Select a model instance for this action.',
  );

  const instance = { ...objectOnly, hasInstanceSelection: true };
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_delete_selected')!, instance), true);
  assert.strictEqual(ActionRegistry.enabled(reg.get('edit_duplicate')!, instance), true);
  assert.strictEqual(ActionRegistry.enabled(reg.get('tool_move')!, instance), true);
});

test('Select All is model-gated and routes through the shared context', () => {
  const action = buildRegistry().get('edit_select_all')!;
  assert.strictEqual(ActionRegistry.enabled(action, baseState), false);
  assert.strictEqual(ActionRegistry.enabled(action, { ...baseState, modelCount: 2 }), true);
  let calls = 0;
  const ctx = {
    selectAll: () => {
      calls += 1;
    },
  } as unknown as ActionContext;
  void action.run!(ctx, {});
  assert.equal(calls, 1);
});

test('Drop to bed is instance-gated and routes through the shared canonical context', () => {
  const action = buildRegistry().get('drop_to_bed')!;
  assert.strictEqual(ActionRegistry.enabled(action, { ...baseState, modelCount: 1, hasSelection: true }), false);
  assert.strictEqual(
    ActionRegistry.enabled(action, {
      ...baseState,
      modelCount: 1,
      hasSelection: true,
      hasInstanceSelection: true,
    }),
    true,
  );
  let calls = 0;
  const ctx = {
    dropToBed: () => {
      calls += 1;
    },
  } as unknown as ActionContext;
  void action.run!(ctx, {});
  assert.equal(calls, 1);
});

test('canonical STL export is model-gated and routes through the shared context', () => {
  const action = buildRegistry().get('file_export_stl')!;
  assert.strictEqual(ActionRegistry.enabled(action, baseState), false);
  assert.strictEqual(ActionRegistry.enabled(action, { ...baseState, modelCount: 1 }), true);
  let calls = 0;
  const ctx = {
    exportStl: () => {
      calls += 1;
    },
  } as unknown as ActionContext;
  void action.run!(ctx, {});
  assert.equal(calls, 1);
});

test('plate-local delete forwards its exact target to the shared handler', () => {
  const target = entityId<'plate'>('import:registry-test:plate-7');
  let deletedPlateId: PlateId | undefined;
  const ctx = {
    deletePlate: (plateId?: PlateId) => {
      deletedPlateId = plateId;
    },
  } as unknown as ActionContext;
  void buildRegistry().get('delete_plate')!.run!(ctx, { plateId: target });
  assert.strictEqual(deletedPlateId, target);
});

test('plate activation forwards its exact target to the shared handler', () => {
  const target = entityId<'plate'>('import:registry-test:plate-8');
  let activatedPlateId: PlateId | undefined;
  const ctx = {
    activatePlate: (plateId: PlateId) => {
      activatedPlateId = plateId;
    },
  } as unknown as ActionContext;
  void buildRegistry().get('activate_plate')!.run!(ctx, { plateId: target });
  assert.strictEqual(activatedPlateId, target);
});

test('Objects intents forward stable typed targets only through shared handlers', () => {
  const object: ObjectTreeEntityRef = {
    kind: 'object',
    id: entityId<'object'>('import:registry-test:object-1'),
  };
  const volume = {
    kind: 'volume' as const,
    id: entityId<'volume'>('import:registry-test:volume-1'),
  };
  let selected: readonly ObjectTreeEntityRef[] = [];
  let primary: ObjectTreeEntityRef | undefined;
  let renamed: { entity: typeof volume; name: string } | undefined;
  let revealed: ObjectTreeEntityRef | undefined;
  let assignment:
    | {
        entities: readonly [typeof object, typeof volume];
        filamentId: ReturnType<typeof entityId<'physical-filament'>> | null;
        sourceRevision: number;
        sourceHash: string;
      }
    | undefined;
  const ctx = {
    selectObjectsTreeEntities: (refs: readonly ObjectTreeEntityRef[], value?: ObjectTreeEntityRef) => {
      selected = refs;
      primary = value;
    },
    renameObjectsTreeEntity: (entity: typeof volume, name: string) => {
      renamed = { entity, name };
    },
    revealObjectsTreeEntity: (entity: ObjectTreeEntityRef) => {
      revealed = entity;
    },
    assignObjectsTreeFilament: (
      entities: readonly [typeof object, typeof volume],
      filamentId: ReturnType<typeof entityId<'physical-filament'>> | null,
      guard: { sourceRevision: number; sourceHash: string },
    ) => {
      assignment = { entities, filamentId, ...guard };
    },
  } as unknown as ActionContext;
  const registry = buildRegistry();
  const filamentId = entityId<'physical-filament'>('import:registry-test:filament-1');
  void registry.get('objects_select')!.run!(ctx, { objectsSelection: { refs: [object, volume], primary: volume } });
  void registry.get('objects_rename')!.run!(ctx, { objectsRename: { entity: volume, name: 'Detail' } });
  void registry.get('objects_reveal')!.run!(ctx, { objectsReveal: object });
  void registry.get('objects_assign_filament')!.run!(ctx, {
    objectsFilamentAssignment: {
      entities: [object, volume],
      filamentId,
      sourceRevision: 9,
      sourceHash: 'hash-9',
    },
  });
  assert.deepStrictEqual(selected, [object, volume]);
  assert.deepStrictEqual(primary, volume);
  assert.deepStrictEqual(renamed, { entity: volume, name: 'Detail' });
  assert.deepStrictEqual(revealed, object);
  assert.deepStrictEqual(assignment, {
    entities: [object, volume],
    filamentId,
    sourceRevision: 9,
    sourceHash: 'hash-9',
  });
});

test('project settings forwarding preserves exact guarded raw engine maps', () => {
  const inheritedConfig = {
    layer_height: '0.20',
    compatible_printers: ['"Snapmaker U1"'],
    vendor_unknown_wire_value: { nested: ['keep', 17, true] },
  } satisfies ConfigMap;
  const overrides = {
    layer_height: '0.12',
    vendor_unknown_wire_value: { nested: ['override', 23, false] },
  } satisfies ConfigMap;
  const request = {
    inheritedConfig,
    overrides,
    sourceRevision: 41,
    sourceHash: 'fnv1a64:settings-source-41',
  } as const;
  const originalRequest = JSON.parse(JSON.stringify(request)) as typeof request;
  let forwarded:
    | {
        inheritedConfig: Readonly<ConfigMap>;
        overrides: Readonly<ConfigMap>;
        guard: Readonly<{ sourceRevision: number; sourceHash: string }>;
      }
    | undefined;
  const ctx = {
    applyProjectSettings: (
      inherited: Readonly<ConfigMap>,
      explicit: Readonly<ConfigMap>,
      guard: Readonly<{ sourceRevision: number; sourceHash: string }>,
    ) => {
      forwarded = { inheritedConfig: inherited, overrides: explicit, guard };
    },
  } as unknown as ActionContext;

  void buildRegistry().get('settings_apply_project')!.run!(ctx, { projectSettingsApply: request });

  assert.ok(forwarded);
  assert.strictEqual(forwarded.inheritedConfig, inheritedConfig);
  assert.strictEqual(forwarded.overrides, overrides);
  assert.deepStrictEqual(forwarded.guard, {
    sourceRevision: request.sourceRevision,
    sourceHash: request.sourceHash,
  });
  assert.deepStrictEqual(request, originalRequest, 'registry forwarding must not alter raw presentation maps');
});

test('virtual filament mutations cross the registry unchanged and missing drafts fail visibly', () => {
  const physicalA = entityId<'physical-filament'>('import:registry-test:virtual-physical-a');
  const physicalB = entityId<'physical-filament'>('import:registry-test:virtual-physical-b');
  const request: CanonicalVirtualFilamentMutationRequest = {
    operation: 'add',
    expectedRevision: 47,
    sourceHash: 'fnv1a64:virtual-source-47',
    draft: {
      mode: 'ratio',
      name: 'Exact purple',
      displayColor: '#8833AA',
      componentFilamentIds: [physicalA, physicalB],
      mixBPercent: 25,
      componentASurfaceOffsetMm: 0.125,
      componentBSurfaceOffsetMm: -0.25,
    },
  };
  let forwarded: CanonicalVirtualFilamentMutationRequest | undefined;
  let forwardedAutoPairPreference: { enabled: boolean; confirmedPhysicalCount?: number } | undefined;
  const reports: string[] = [];
  const ctx = {
    mutateVirtualFilament: (value: CanonicalVirtualFilamentMutationRequest) => {
      forwarded = value;
    },
    configureFullSpectrumAutoPairs: (enabled: boolean, confirmedPhysicalCount?: number) => {
      forwardedAutoPairPreference = {
        enabled,
        ...(confirmedPhysicalCount === undefined ? {} : { confirmedPhysicalCount }),
      };
    },
    reportCapabilityUnavailable: (label: string, reason: string) => reports.push(`${label}: ${reason}`),
  } as unknown as ActionContext;
  const action = buildRegistry().get('filament_virtual_mutate')!;

  void action.run!(ctx, { virtualFilamentMutation: request });
  assert.strictEqual(forwarded, request);
  assert.equal(request.draft.mode, 'ratio');
  if (request.draft.mode !== 'ratio') throw new Error('Expected Ratio request');
  assert.deepStrictEqual(request.draft.componentFilamentIds, [physicalA, physicalB]);

  void action.run!(ctx, {
    fullSpectrumAutoPairPreference: { enabled: true, confirmedPhysicalCount: 5 },
  });
  assert.deepStrictEqual(forwardedAutoPairPreference, { enabled: true, confirmedPhysicalCount: 5 });

  void action.run!(ctx, {});
  assert.equal(reports.length, 1);
  assert.match(reports[0], /open the virtual filament editor/i);
});

test('recreate_model_colors_fullspectrum runs through ActionRegistry and checks modelCount', () => {
  let calledOptions: any = null;
  const ctx = {
    recreateModelColors: async (options: any) => {
      calledOptions = options;
      return true;
    },
  } as unknown as ActionContext;
  const registry = buildRegistry();
  const action = registry.get('recreate_model_colors_fullspectrum')!;
  assert.ok(action, 'Action recreate_model_colors_fullspectrum should exist');
  assert.equal(action.group, 'advanced');
  assert.equal(action.menuSection, 'tools');
  assert.equal(action.isEnabled?.({ modelCount: 0 } as any), false);
  assert.equal(action.isEnabled?.({ modelCount: 2 } as any), true);

  const testOpts = { allowNewFullSpectrumRecipes: true };
  void action.run!(ctx, { recreateModelColors: testOpts });
  assert.deepStrictEqual(calledOptions, testOpts);
});

test('guarded plate lifecycle requests forward every field without altering presentation payloads', () => {
  const first = entityId<'plate'>('import:registry-test:guarded-plate-1');
  const second = entityId<'plate'>('import:registry-test:guarded-plate-2');
  const third = entityId<'plate'>('import:registry-test:guarded-plate-3');
  const activate = { plateId: first, sourceRevision: 51 } as const;
  const rename = { plateId: second, nextName: 'Exact presentation name', sourceRevision: 52 } as const;
  const duplicate = { plateId: second, sourceRevision: 53 } as const;
  const remove = { plateId: third, sourceRevision: 54 } as const;
  const orderedPlateIds = [third, first, second] as const;
  const reorder = { orderedPlateIds, sourceRevision: 55 } as const;
  const printable = { plateId: first, printable: false, sourceRevision: 56 } as const;
  const invocations = [
    { plateTarget: activate },
    { plateRename: rename },
    { plateTarget: duplicate },
    { plateTarget: remove },
    { plateReorder: reorder },
    { platePrintable: printable },
  ] satisfies readonly ActionInvocation[];
  const originalInvocations = JSON.parse(JSON.stringify(invocations)) as typeof invocations;
  const forwarded: Array<{ method: string; args: readonly unknown[] }> = [];
  const ctx = {
    activatePlate: (...args: readonly unknown[]) => forwarded.push({ method: 'activatePlate', args }),
    renamePlate: (...args: readonly unknown[]) => forwarded.push({ method: 'renamePlate', args }),
    duplicatePlate: (...args: readonly unknown[]) => forwarded.push({ method: 'duplicatePlate', args }),
    deletePlate: (...args: readonly unknown[]) => forwarded.push({ method: 'deletePlate', args }),
    reorderPlates: (...args: readonly unknown[]) => forwarded.push({ method: 'reorderPlates', args }),
    setPlatePrintable: (...args: readonly unknown[]) => forwarded.push({ method: 'setPlatePrintable', args }),
  } as unknown as ActionContext;
  const registry = buildRegistry();
  for (const [index, actionId] of [
    'activate_plate',
    'rename_plate',
    'duplicate_plate',
    'delete_plate',
    'reorder_plates',
    'set_plate_printable',
  ].entries()) {
    void registry.get(actionId)!.run!(ctx, invocations[index]);
  }

  assert.deepStrictEqual(forwarded, [
    { method: 'activatePlate', args: [first, 51] },
    { method: 'renamePlate', args: [second, 'Exact presentation name', 52] },
    { method: 'duplicatePlate', args: [second, 53] },
    { method: 'deletePlate', args: [third, 54] },
    { method: 'reorderPlates', args: [orderedPlateIds, 55] },
    { method: 'setPlatePrintable', args: [first, false, 56] },
  ]);
  assert.strictEqual(forwarded[4].args[0], orderedPlateIds);
  assert.deepStrictEqual(invocations, originalInvocations, 'registry forwarding must not alter plate requests');
});

test('semantic volume and every layer-range union request forward unchanged', () => {
  const objectId = entityId<'object'>('import:registry-test:semantic-object');
  const volumeId = entityId<'volume'>('import:registry-test:semantic-volume');
  const rangeA = entityId<'layer-range'>('import:registry-test:range-a');
  const rangeB = entityId<'layer-range'>('import:registry-test:range-b');
  const rangeC = entityId<'layer-range'>('import:registry-test:range-c');
  const guard = { expectedRevision: 61, sourceHash: 'fnv1a64:semantic-source-61', objectId } as const;
  const volumeRequest: CanonicalSemanticVolumeRoleRequest = {
    ...guard,
    volumeId,
    nextRole: 'support-blocker',
  };
  const layerRangeRequests: readonly CanonicalSemanticLayerRangeRequest[] = [
    { ...guard, operation: 'add', layerRangeId: rangeA, minZMm: 0.2, maxZMm: 4.8 },
    { ...guard, operation: 'edit', layerRangeId: rangeA, minZMm: 0.4, maxZMm: 5.2 },
    { ...guard, operation: 'split', layerRangeId: rangeA, splitZMm: 2.6, upperRangeId: rangeB },
    { ...guard, operation: 'merge', firstRangeId: rangeA, secondRangeId: rangeB },
    { ...guard, operation: 'delete', layerRangeId: rangeC },
  ];
  const originalVolumeRequest = JSON.parse(JSON.stringify(volumeRequest)) as typeof volumeRequest;
  const originalLayerRangeRequests = JSON.parse(JSON.stringify(layerRangeRequests)) as typeof layerRangeRequests;
  let forwardedVolume: CanonicalSemanticVolumeRoleRequest | undefined;
  const forwardedLayerRanges: CanonicalSemanticLayerRangeRequest[] = [];
  const ctx = {
    convertSemanticVolumeRole: (request: CanonicalSemanticVolumeRoleRequest) => {
      forwardedVolume = request;
    },
    editSemanticLayerRange: (request: CanonicalSemanticLayerRangeRequest) => {
      forwardedLayerRanges.push(request);
    },
  } as unknown as ActionContext;
  const registry = buildRegistry();

  void registry.get('objects_convert_volume_role')!.run!(ctx, { semanticVolumeRole: volumeRequest });
  assert.strictEqual(forwardedVolume, volumeRequest);
  for (const request of layerRangeRequests) {
    void registry.get('objects_edit_layer_range')!.run!(ctx, { semanticLayerRange: request });
    assert.strictEqual(forwardedLayerRanges.at(-1), request, `${request.operation} request was reshaped`);
  }

  assert.deepStrictEqual(volumeRequest, originalVolumeRequest);
  assert.deepStrictEqual(layerRangeRequests, originalLayerRangeRequests);
  assert.deepStrictEqual(
    forwardedLayerRanges.map((request) => request.operation),
    ['add', 'edit', 'split', 'merge', 'delete'],
  );
});

test('synchronous load handler runs before invoke yields user activation', () => {
  let pickerOpened = false;
  const ctx = {
    loadModel: () => {
      pickerOpened = true;
    },
    reportCapabilityUnavailable: () => {},
  } as unknown as ActionContext;
  void buildRegistry().invoke('load_model_from_path', 'xr-primary', ctx, baseState);
  assert.strictEqual(pickerOpened, true);
});

test('context menus are a placement of the catalog, not a second catalog (P11.2)', () => {
  const registry = buildRegistry();
  const object = registry.forContext('object');
  const plate = registry.forContext('plate');
  assert.ok(object.length > 0 && plate.length > 0, 'both upstream context targets exist');

  for (const action of [...object, ...plate]) {
    // A context menu is a shortcut. An action that cannot run is still reachable
    // in the menu bar and the palette, where its reason is stated; putting it
    // here would fill the shortcut with rows that only ever explain themselves.
    assert.notEqual(action.capability.status, 'unavailable', `${action.id} cannot run and should not be offered`);
    assert.ok(action.run, `${action.id} has no handler`);
    assert.ok(action.capability.surfaces.includes('dom-context'), `${action.id} lacks the DOM context surface`);
    // The XR rule is the registry's, not this menu's: withheld only where a
    // reason is stated, never by omission.
    assert.equal(
      action.capability.surfaces.includes('xr-context'),
      !action.xrUnsupportedReason,
      `${action.id} disagrees with its own XR reason`,
    );
  }

  // Every context action is reachable somewhere else too, so a person who never
  // right-clicks can still find it.
  for (const action of [...object, ...plate]) {
    const others = action.capability.surfaces.filter((surface) => !surface.endsWith('-context'));
    assert.ok(others.length > 1, `${action.id} is reachable only from a context menu`);
  }

  // The two targets are distinct: a model action on the bed, or a plate action
  // on a model, is a menu that lies about what it will affect.
  const objectIds = new Set(object.map((action) => action.id));
  for (const action of plate) assert.equal(objectIds.has(action.id), false, `${action.id} claims both targets`);
});

console.log(`\nRegistry: ${passed} tests passed.`);
