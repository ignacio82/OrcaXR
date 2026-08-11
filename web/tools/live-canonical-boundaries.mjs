import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export function inspectLiveCanonicalBoundaries(root) {
  const read = (relative) => {
    const file = path.join(root, relative);
    return [relative, parse(file, fs.readFileSync(file, 'utf8'))];
  };
  const main = read('src/main.ts');
  const workspace = read('src/workspace/OrcaWorkspace.ts');
  const controller = read('src/workspace/CanonicalWorkspaceController.ts');
  const slicer = read('src/workspace/CanonicalWorkspaceSlicer.ts');
  const workerSerializer = read('src/project/serialization/WorkerProjectSerializer.ts');
  const presentation = readSourceTree(root, 'src/ui');
  return [
    ...inspectMain(...main),
    ...inspectObjectsGateway(...main),
    ...inspectSemanticObjectsGateway(...main),
    ...inspectSettingsGateway(...main),
    ...inspectVirtualFilamentsGateway(...main),
    ...presentation.flatMap(([file, source]) =>
      inspectSemanticObjectsGateway(file, source, { requireRegistryInvocation: false }),
    ),
    ...presentation.flatMap(([file, source]) =>
      inspectSettingsGateway(file, source, { requireRegistryInvocation: false }),
    ),
    ...presentation.flatMap(([file, source]) =>
      inspectVirtualFilamentsGateway(file, source, { requireRegistryInvocation: false }),
    ),
    ...inspectSave(...workspace),
    ...inspectNewProject(...workspace),
    ...inspectOpen(...workspace),
    ...inspectSlice(...workspace),
    ...inspectImports(...workspace),
    ...inspectOwner(...workspace),
    ...inspectController(...controller),
    ...inspectSlicer(...slicer),
    ...inspectWorkerSerializer(...workerSerializer),
  ];
}

export function selfTestLiveCanonicalBoundaries() {
  const cases = [
    [
      'legacy save writer',
      inspectSave,
      `class OrcaWorkspace { saveProject() { this.buildProjectBytes(); } }`,
      'scene objects',
    ],
    [
      'legacy new project reset',
      inspectNewProject,
      `class OrcaWorkspace { newProject() {
        this.models.splice(0); this.plates.splice(0); this.workspace.clear();
      } }`,
      'canonical controller',
    ],
    [
      'preview bypass',
      inspectOpen,
      `class OrcaWorkspace { async openProject(bytes) {
        await this.canonicalProject.openCanonical3mf(bytes); new ThreeMFLoader();
      } }`,
      'bypass worker',
    ],
    [
      'empty acknowledgement',
      inspectOpen,
      `class OrcaWorkspace { async openProject(bytes) {
        const prepared = await this.canonicalProject.prepareCanonical3mfImport(bytes);
        const preview = prepared.preview; const confirm = this.onProjectImportPreview;
        if (!confirm) return; if (!(await confirm(preview))) return;
        prepared.confirm({ confirmed: true, acknowledgedNoticeIds: [] });
      } }`,
      'acknowledgement decision or exact preview notice IDs',
    ],
    [
      'scene-baked slice',
      inspectSlice,
      `class OrcaWorkspace { async sliceNow() {
        const slicer = new CanonicalWorkspaceSlicer({ workspace: this.canonicalProject });
        await slicer.startCurrentPlate().completion;
        const legacy = this.slicer; await legacy.slice(this.bakeToPrinterStl());
      } }`,
      'scene-baked STL',
    ],
    [
      'wrong slice source',
      inspectSlice,
      `class OrcaWorkspace { async sliceNow() {
        const slicer = new CanonicalWorkspaceSlicer({ workspace: this.sceneStore });
        await slicer.startCurrentPlate().completion;
      } }`,
      'canonical controller as workspace',
    ],
    [
      'scene-attached import',
      inspectImports,
      `class OrcaWorkspace {
        addModelFromGeometry(raw) { this.canonicalProject.importBufferGeometry(raw); }
        loadModelFromGeometry(raw) { this.addModelFromGeometry(raw); }
        importModelFile(name, bytes) { this.canonicalProject.prepareModelImport(bytes); }
        loadModelFromBuffer(name, raw) { this.workspace.add(raw); this.importModelFile(name, raw); }
        loadModelFromUrl(url) { this.importModelFile(url, url); }
        importZipArchive(raw, name) { return this.importModelFile(name, raw); }
      }`,
      'attach imported geometry',
    ],
    [
      'untransacted model import',
      inspectImports,
      `class OrcaWorkspace {
        addModelFromGeometry(raw) { this.canonicalProject.importBufferGeometry(raw); }
        loadModelFromGeometry(raw) { this.addModelFromGeometry(raw); }
        importModelFile(name, bytes) { const decoded = decodeModelImport(bytes); this.loadModelFromGeometry(decoded); }
        loadModelFromBuffer(name, raw) { return this.importModelFile(name, raw); }
        loadModelFromUrl(url) { return this.importModelFile(url, url); }
        importZipArchive(raw, name) { return this.importModelFile(name, raw); }
      }`,
      'model import must stage through the canonical import coordinator',
    ],
    [
      'per-entry archive commit',
      inspectImports,
      `class OrcaWorkspace {
        addModelFromGeometry(raw) { this.canonicalProject.importBufferGeometry(raw); }
        loadModelFromGeometry(raw) { this.addModelFromGeometry(raw); }
        importModelFile(name, bytes) { this.canonicalProject.prepareModelImport(bytes); }
        loadModelFromBuffer(name, raw) { return this.importModelFile(name, raw); }
        loadModelFromUrl(url) { return this.importModelFile(url, url); }
        importZipArchive(raw) { for (const entry of unzipSync(raw)) this.loadModelFromGeometry(entry); }
      }`,
      'must route model sources through one transaction',
    ],
    [
      'second model owner',
      inspectOwner,
      `class OrcaWorkspace {
        readonly canonicalProject; get plates() { return []; } get activePlateId() { return 'plate'; }
        models = []; get selectedModel() { return null; }
      }`,
      'models must remain getter-only',
    ],
    [
      'main loader',
      inspectMain,
      `import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
       workspace.onProjectImportPreview = async () => true;
       projectInput.accept = '.3mf'; projectInput.onchange = () => workspace.openProject(bytes);`,
      'ThreeMFLoader',
    ],
    [
      'picker bypass',
      inspectMain,
      `workspace.onProjectImportPreview = async () => true;
       projectInput.accept = '.3mf'; projectInput.onchange = () => workspace.loadModelFromGroup(group);`,
      '3MF picker must call workspace.openProject',
    ],
    [
      'Objects side door',
      inspectObjectsGateway,
      `new ObjectsPanel(host, adapter);
       workspace.setObjectsTreeSelection([entity]);
       workspace.renameObjectsTreeEntity(entity, 'renamed');
       workspace.revealObjectsTreeEntity(entity);
       workspace.setFilamentAssignments([entity], filamentId, guard);`,
      'Objects UI cannot bypass the action registry',
    ],
    [
      'settings action omission',
      inspectSettingsGateway,
      `new GeneratedSettingsPanel(host, adapter);`,
      'Generated settings UI must route settings_apply_project through registry.invoke',
    ],
    [
      'settings side door',
      inspectSettingsGateway,
      `new GeneratedSettingsPanel(host, adapter);
       registry.invoke('settings_apply_project', 'dom-inspector', actionCtx, state, invocation);
       workspace.setProjectSettingsOverrides(inheritedConfig, overrides, guard);`,
      'Generated settings UI cannot bypass the action registry',
    ],
    [
      'semantic Objects side door',
      inspectSemanticObjectsGateway,
      `new SemanticObjectEditor(host, adapter);
       registry.invoke('objects_convert_volume_role', 'dom-inspector', actionCtx, state, invocation);
       registry.invoke('objects_edit_layer_range', 'dom-inspector', actionCtx, state, invocation);
       workspace.convertSemanticVolumeRole(request);
       workspace.editSemanticLayerRange(request);`,
      'Semantic Objects UI cannot bypass the action registry',
    ],
    [
      'virtual filament action omission',
      inspectVirtualFilamentsGateway,
      `new VirtualFilamentLibrary(host, adapter);`,
      'Virtual filament UI must route filament_virtual_mutate through registry.invoke',
    ],
    [
      'virtual filament side door',
      inspectVirtualFilamentsGateway,
      `new VirtualFilamentLibrary(host, adapter);
       registry.invoke('filament_virtual_mutate', 'dom-inspector', actionCtx, state, invocation);
       workspace.mutateVirtualFilament(request);`,
      'Virtual filament UI cannot bypass the action registry',
    ],
    [
      'main-thread archive authoring',
      inspectSlicer,
      `class CanonicalWorkspaceSlicer { constructor(options) {
        const route = new CanonicalSlicerClientRoute({ client: options.client });
        this.coordinator = new CanonicalSliceJobCoordinator({
          source: options.workspace.createCanonicalSliceSource(),
          serializer: new Bbs3mfProjectSerializer(),
          profiles: new CanonicalStateProfileResolver(),
          route,
        });
      } }`,
      'off the main thread',
    ],
    [
      'worker serializer writing another format',
      inspectWorkerSerializer,
      `class WorkerProjectSerializer { constructor(options) {
        this.fallback = options.fallback ?? new PlainStlSerializer();
      } }`,
      'canonical BBS 3MF codec',
    ],
  ];
  const failures = [];
  for (const [label, inspector, text, expected] of cases) {
    const observed = inspector(`self-test-${label}.ts`, parse(`self-test-${label}.ts`, text));
    if (!observed.some((entry) => entry.includes(expected))) {
      failures.push(`tools/live-canonical-boundaries.mjs:1 self-test “${label}” missed ${expected}`);
    }
  }
  const negative = inspectMain(
    'self-test-comments.ts',
    parse(
      'self-test-comments.ts',
      `const note = 'ThreeMFLoader'; // new ThreeMFLoader().parse(bytes)
       workspace.onProjectImportPreview = async () => true;
       projectInput.accept = '.3mf'; projectInput.onchange = () => workspace.openProject(bytes);`,
    ),
  );
  if (negative.length > 0) {
    failures.push(
      `tools/live-canonical-boundaries.mjs:1 comments/string negative control failed: ${negative.join('; ')}`,
    );
  }
  const decisionControl = inspectOpen(
    'self-test-decision.ts',
    parse(
      'self-test-decision.ts',
      `class OrcaWorkspace { async openProject(bytes) {
        const prepared = await this.canonicalProject.prepareCanonical3mfImport(bytes);
        const preview = prepared.preview; const showPreview = this.onProjectImportPreview;
        if (!showPreview) return; const decision = await showPreview(preview);
        if (!decision.confirmed) return; prepared.confirm(decision);
      } }`,
    ),
  );
  if (decisionControl.length > 0) {
    failures.push(
      `tools/live-canonical-boundaries.mjs:1 structured-decision control failed: ${decisionControl.join('; ')}`,
    );
  }
  const objectsControl = inspectObjectsGateway(
    'self-test-objects-gateway.ts',
    parse(
      'self-test-objects-gateway.ts',
      `new ObjectsPanel(host, adapter);
       registry.invoke('objects_select', 'dom-inspector', actionCtx, state, invocation);
       registry.invoke('objects_rename', 'dom-inspector', actionCtx, state, invocation);
       registry.invoke('objects_reveal', 'dom-inspector', actionCtx, state, invocation);
       registry.invoke('objects_assign_filament', 'dom-inspector', actionCtx, state, invocation);`,
    ),
  );
  if (objectsControl.length > 0) {
    failures.push(`tools/live-canonical-boundaries.mjs:1 Objects gateway control failed: ${objectsControl.join('; ')}`);
  }
  const settingsControl = inspectSettingsGateway(
    'self-test-settings-gateway.ts',
    parse(
      'self-test-settings-gateway.ts',
      `new GeneratedSettingsPanel(host, {
         apply: (request) => registry.invoke(
           'settings_apply_project', 'dom-inspector', actionCtx, state, request
         ),
       });`,
    ),
  );
  if (settingsControl.length > 0) {
    failures.push(
      `tools/live-canonical-boundaries.mjs:1 generated settings gateway control failed: ${settingsControl.join('; ')}`,
    );
  }
  const settingsSyntaxControl = inspectSettingsGateway(
    'self-test-settings-comments.ts',
    parse(
      'self-test-settings-comments.ts',
      `const note = 'workspace.setProjectSettingsOverrides(inherited, overrides, guard)';
       // workspace.setProjectSettingsOverrides(inherited, overrides, guard);
       registry.invoke('settings_apply_project', 'dom-inspector', actionCtx, state, invocation);`,
    ),
  );
  if (settingsSyntaxControl.length > 0) {
    failures.push(
      `tools/live-canonical-boundaries.mjs:1 generated settings syntax control failed: ${settingsSyntaxControl.join('; ')}`,
    );
  }
  const semanticObjectsControl = inspectSemanticObjectsGateway(
    'self-test-semantic-objects-gateway.ts',
    parse(
      'self-test-semantic-objects-gateway.ts',
      `new SemanticObjectEditor(host, {
         onConvertVolumeRole: (request) => registry.invoke(
           'objects_convert_volume_role', 'dom-inspector', actionCtx, state, request
         ),
         onAddLayerRange: (request) => registry.invoke(
           'objects_edit_layer_range', 'dom-inspector', actionCtx, state, request
         ),
       });`,
    ),
  );
  if (semanticObjectsControl.length > 0) {
    failures.push(
      `tools/live-canonical-boundaries.mjs:1 semantic Objects gateway control failed: ${semanticObjectsControl.join('; ')}`,
    );
  }
  const virtualFilamentsControl = inspectVirtualFilamentsGateway(
    'self-test-virtual-filaments-gateway.ts',
    parse(
      'self-test-virtual-filaments-gateway.ts',
      `new VirtualFilamentLibrary(host, {
         onAdd: (request) => registry.invoke(
           'filament_virtual_mutate', 'dom-inspector', actionCtx, state, request
         ),
       });`,
    ),
  );
  if (virtualFilamentsControl.length > 0) {
    failures.push(
      `tools/live-canonical-boundaries.mjs:1 virtual filament gateway control failed: ${virtualFilamentsControl.join('; ')}`,
    );
  }
  return failures;
}

function inspectMain(file, source) {
  const check = context(file, source);
  const all = facts(source);
  const loader = all.identifiers.find((entry) => entry.text === 'ThreeMFLoader');
  if (loader) check.fail(loader.node, 'ThreeMFLoader is forbidden in the live composition root');
  check.requireAssignment(all, 'workspace.onProjectImportPreview', 'install an explicit import-preview surface');
  check.forbidCalls(all, {
    'workspace.loadModelFromGroup': 'project archives cannot enter a scene-group importer',
    'workspace.openCanonical3mf': 'project open cannot bypass worker preview',
  });

  const accept = all.assignments.find(
    (entry) =>
      entry.path.endsWith('.accept') &&
      ts.isStringLiteralLike(entry.node.right) &&
      entry.node.right.text.toLowerCase().includes('.3mf'),
  );
  const input = accept?.path.slice(0, -'.accept'.length);
  const onchange = input ? all.assignments.find((entry) => entry.path === `${input}.onchange`) : undefined;
  if (
    !accept ||
    !onchange ||
    !facts(onchange.node.right).calls.some((entry) => entry.path === 'workspace.openProject')
  ) {
    check.fail(onchange?.node ?? accept?.node ?? source, '3MF picker must call workspace.openProject');
  }
  return check.failures;
}

function inspectObjectsGateway(file, source) {
  const check = context(file, source);
  const all = facts(source);
  for (const actionId of ['objects_select', 'objects_rename', 'objects_reveal', 'objects_assign_filament']) {
    if (!hasRegistryInvocation(all, actionId)) {
      check.fail(source, `Objects UI must route ${actionId} through registry.invoke`);
    }
  }
  check.forbidCalls(all, {
    'workspace.setObjectsTreeSelection': 'Objects UI cannot bypass the action registry for selection',
    'workspace.renameObjectsTreeEntity': 'Objects UI cannot bypass the action registry for rename',
    'workspace.revealObjectsTreeEntity': 'Objects UI cannot bypass the action registry for scene reveal',
    'workspace.setFilamentAssignments': 'Objects UI cannot bypass the action registry for filament assignment',
  });
  return check.failures;
}

function inspectSettingsGateway(file, source, options = {}) {
  const check = context(file, source);
  const all = facts(source);
  if ((options.requireRegistryInvocation ?? true) && !hasRegistryInvocation(all, 'settings_apply_project')) {
    check.fail(source, 'Generated settings UI must route settings_apply_project through registry.invoke');
  }
  for (const call of all.calls) {
    if (call.path === 'setProjectSettingsOverrides' || call.path.endsWith('.setProjectSettingsOverrides')) {
      check.fail(call.node, 'Generated settings UI cannot bypass the action registry for project setting writes');
    }
  }
  return check.failures;
}

function inspectSemanticObjectsGateway(file, source, options = {}) {
  const check = context(file, source);
  const all = facts(source);
  if (options.requireRegistryInvocation ?? true) {
    for (const actionId of ['objects_convert_volume_role', 'objects_edit_layer_range']) {
      if (!hasRegistryInvocation(all, actionId)) {
        check.fail(source, `Semantic Objects UI must route ${actionId} through registry.invoke`);
      }
    }
  }
  check.forbidCalls(all, {
    'workspace.convertSemanticVolumeRole':
      'Semantic Objects UI cannot bypass the action registry for volume-role conversion',
    'workspace.editSemanticLayerRange':
      'Semantic Objects UI cannot bypass the action registry for height-range mutation',
  });
  return check.failures;
}

function inspectVirtualFilamentsGateway(file, source, options = {}) {
  const check = context(file, source);
  const all = facts(source);
  if ((options.requireRegistryInvocation ?? true) && !hasRegistryInvocation(all, 'filament_virtual_mutate')) {
    check.fail(source, 'Virtual filament UI must route filament_virtual_mutate through registry.invoke');
  }
  for (const call of all.calls) {
    if (
      call.path === 'mutateVirtualFilament' ||
      call.path.endsWith('.mutateVirtualFilament') ||
      call.path === 'addVirtualFilament' ||
      call.path.endsWith('.addVirtualFilament') ||
      call.path === 'editVirtualFilament' ||
      call.path.endsWith('.editVirtualFilament') ||
      call.path === 'duplicateVirtualFilament' ||
      call.path.endsWith('.duplicateVirtualFilament') ||
      call.path === 'setVirtualFilamentEnabled' ||
      call.path.endsWith('.setVirtualFilamentEnabled') ||
      call.path === 'deleteVirtualFilament' ||
      call.path.endsWith('.deleteVirtualFilament')
    ) {
      check.fail(call.node, 'Virtual filament UI cannot bypass the action registry for canonical recipe writes');
    }
  }
  return check.failures;
}

function inspectSave(file, source) {
  const check = context(file, source);
  const body = check.method('OrcaWorkspace', 'saveProject');
  if (!body) return check.failures;
  const all = facts(body);
  check.requireCall(all, 'this.canonicalProject.saveCanonical3mf', 'save canonical project state');
  check.forbidCalls(all, {
    'this.buildProjectBytes': 'save cannot rebuild project bytes from scene objects',
    buildProjectBytes: 'save cannot rebuild project bytes from scene objects',
    writeProject3mf: 'save cannot use the legacy geometry writer',
    writeMinimal3mf: 'save cannot use the legacy geometry writer',
    'this.captureSemanticProjectSnapshot': 'save cannot snapshot legacy scene state',
    'this.bakeToPrinterStl': 'save cannot bake scene geometry',
  });
  check.forbidProperties(all, {
    'this.models': 'save cannot treat scene models as authority',
    'this.plates': 'save cannot treat legacy plates as authority',
    'this.originalProject': 'save cannot reuse raw imported bytes',
  });
  return check.failures;
}

function inspectNewProject(file, source) {
  const check = context(file, source);
  const body = check.method('OrcaWorkspace', 'newProject');
  if (!body) return check.failures;
  const all = facts(body);
  check.requireCall(
    all,
    'this.canonicalProject.resetProject',
    'new project must reset through the canonical controller',
  );
  check.forbidCalls(all, {
    'this.workspace.clear': 'new project cannot clear the projected scene as project authority',
    'this.models.splice': 'new project cannot mutate a scene-model list',
    'this.plates.splice': 'new project cannot mutate a legacy plate list',
  });
  check.forbidProperties(all, {
    'this.models': 'new project cannot use scene models as project authority',
    'this.plates': 'new project cannot use legacy plates as project authority',
  });
  return check.failures;
}

function inspectOpen(file, source) {
  const check = context(file, source);
  const body = check.method('OrcaWorkspace', 'openProject');
  if (!body) return check.failures;
  const all = facts(body);
  const prepare = all.calls.find((entry) => entry.path === 'this.canonicalProject.prepareCanonical3mfImport');
  if (!prepare) check.fail(body, 'open must prepare import through the canonical worker seam');
  const prepared = prepare ? assignedIdentifier(prepare.node) : undefined;
  if (!prepared || !all.calls.some((entry) => entry.path === `${prepared}.confirm`)) {
    check.fail(body, 'open must explicitly commit the prepared preview');
  }
  if (!all.properties.some((entry) => entry.path === 'this.onProjectImportPreview')) {
    check.fail(body, 'open must consult its import-preview surface');
  }
  const decision = previewDecision(body, all, 'this.onProjectImportPreview');
  if (!decision.conditional) {
    check.fail(body, 'open must branch on the user preview decision');
  }
  if (!acknowledgesPreview(all, prepared, decision.resultName)) {
    check.fail(body, 'open must pass an acknowledgement decision or exact preview notice IDs');
  }
  check.forbidCalls(all, {
    'this.canonicalProject.openCanonical3mf': 'open cannot bypass worker parsing and preview',
    parseProject3mf: 'open cannot use the legacy sidecar reader',
    'this.newProject': 'open must replace through one canonical command',
    'this.addModelFromGeometry': 'open cannot rebuild project state mesh by mesh',
    'this.loadModelFromGroup': 'open cannot treat a Three group as project authority',
  });
  check.forbidNews(all, { ThreeMFLoader: 'open cannot parse projects into a Three scene' });
  check.forbidProperties(all, {
    'this.models': 'open cannot mutate the scene-model projection',
    'this.plates': 'open cannot mutate the legacy plate projection',
  });
  return check.failures;
}

function inspectSlice(file, source) {
  const check = context(file, source);
  const body = check.method('OrcaWorkspace', 'sliceNow');
  if (!body) return check.failures;
  const all = facts(body);
  const creation = all.news.find((entry) => entry.path === 'CanonicalWorkspaceSlicer');
  if (!creation) check.fail(body, 'slice must construct CanonicalWorkspaceSlicer');
  if (!creation || !objectArgumentHasPath(creation.node, 'workspace', 'this.canonicalProject')) {
    check.fail(creation?.node ?? body, 'slice must pass the canonical controller as workspace');
  }
  const variable = creation ? assignedIdentifier(creation.node) : undefined;
  const start = variable ? all.calls.find((entry) => entry.path === `${variable}.startCurrentPlate`) : undefined;
  if (!start) check.fail(body, 'slice must submit the active canonical plate');
  else if (!awaitsCompletion(start.node)) check.fail(start.node, 'slice must await canonical plate completion');
  check.forbidCalls(all, {
    'this.bakeToPrinterStl': 'slice cannot use a scene-baked STL',
    'this.mergedPrinterGeometry': 'slice cannot derive input from rendered meshes',
    'this.printerGeometries': 'slice cannot derive input from rendered meshes',
    'this.buildPaintedInput': 'slice cannot derive paint input from vertex colors',
    'this.captureSemanticProjectSnapshot': 'slice cannot use the legacy scene guard',
    selectSemanticSliceRoute: 'slice cannot select a legacy geometry/raw-source route',
    requireSemanticSlice: 'slice cannot use a legacy semantic fallback',
  });
  const aliases = new Set(['this.slicer']);
  visit(body, (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (expressionPath(node.initializer) === 'this.slicer') aliases.add(node.name.text);
    }
  });
  for (const call of all.calls) {
    if (
      [...aliases].some(
        (alias) =>
          /\.(?:slice|slicePainted|sliceProject|sliceProjectWithRoute)$/.test(call.path) &&
          call.path.startsWith(`${alias}.`),
      )
    ) {
      check.fail(call.node, `slice cannot call ${call.path} directly`);
    }
  }
  check.forbidProperties(all, {
    'this.models': 'slice cannot use the scene-model projection',
    'this.originalProject': 'slice cannot reuse raw imported project bytes',
    'this.originalProjectSnapshot': 'slice cannot use a legacy semantic snapshot',
  });
  return check.failures;
}

function inspectImports(file, source) {
  const check = context(file, source);
  const placement = check.method('OrcaWorkspace', 'addModelFromGeometry');
  if (placement) {
    const all = facts(placement);
    check.requireCall(all, 'this.canonicalProject.importBufferGeometry', 'model placement must commit canonically');
    check.forbidCalls(all, sceneImportCalls('model placement'));
  }
  const publicPlacement = check.method('OrcaWorkspace', 'loadModelFromGeometry');
  if (publicPlacement) {
    check.requireCall(
      facts(publicPlacement),
      'this.addModelFromGeometry',
      'public geometry import must enter canonical placement',
    );
  }
  for (const name of ['importModelFile', 'loadModelFromBuffer', 'loadModelFromUrl', 'importZipArchive']) {
    const method = check.method('OrcaWorkspace', name);
    if (!method) continue;
    const all = facts(method);
    check.forbidNews(all, {
      ThreeMFLoader: `${name} cannot parse a project into a Three scene`,
      OBJLoader: `${name} cannot import a scene graph outside one transaction`,
      STLLoader: `${name} cannot decode meshes outside the canonical import dispatcher`,
    });
    check.forbidCalls(all, {
      ...sceneImportCalls(name),
      'this.loadModelFromGroup': `${name} cannot import a mutable scene group`,
      'this.adoptPaletteFrom3mf': `${name} cannot mutate palette outside the project transaction`,
      extract3mfImportMetadata: `${name} cannot split metadata from canonical parsing`,
    });
  }
  // Every file-backed model source enters the transactional canonical import.
  for (const name of ['loadModelFromBuffer', 'importZipArchive', 'loadModelFromUrl']) {
    const method = check.method('OrcaWorkspace', name);
    if (!method) continue;
    const all = facts(method);
    check.requireCall(all, 'this.importModelFile', `${name} must route model sources through one transaction`);
    check.forbidCalls(all, {
      'this.loadModelFromGeometry': `${name} cannot commit decoded entries one at a time`,
      unzipSync: `${name} cannot expand an archive outside the guarded decoder`,
    });
  }
  const modelImport = check.method('OrcaWorkspace', 'importModelFile');
  if (modelImport) {
    const all = facts(modelImport);
    check.requireCall(
      all,
      'this.canonicalProject.prepareModelImport',
      'model import must stage through the canonical import coordinator',
    );
    check.forbidCalls(all, {
      'this.loadModelFromGeometry': 'model import cannot commit decoded entries one at a time',
      'this.addModelFromGeometry': 'model import cannot bypass its own preview transaction',
      decodeModelImport: 'model import must decode inside the staged parser, not the workspace',
      unzipSync: 'model import cannot expand an archive outside the guarded decoder',
    });
  }
  return check.failures;
}

function sceneImportCalls(label) {
  return {
    'this.workspace.add': `${label} cannot attach imported geometry directly to the scene`,
    'this.plateAnchor.add': `${label} cannot attach imported geometry directly to the scene`,
    'this.models.push': `${label} cannot append to a mutable scene-model list`,
    'this.plates.push': `${label} cannot append to a mutable plate list`,
  };
}

function inspectOwner(file, source) {
  const check = context(file, source);
  const owner = findClass(source, 'OrcaWorkspace');
  if (!owner) return check.failures;
  const canonical = owner.members.find(
    (member) => ts.isPropertyDeclaration(member) && memberName(member.name) === 'canonicalProject',
  );
  if (!canonical?.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword)) {
    check.fail(canonical ?? owner, 'canonicalProject must be readonly');
  }
  for (const name of ['plates', 'activePlateId', 'models', 'selectedModel']) {
    const members = owner.members.filter((member) => memberName(member.name) === name);
    if (members.length !== 1 || !ts.isGetAccessorDeclaration(members[0])) {
      check.fail(members[0] ?? owner, `${name} must remain getter-only canonical projection`);
    }
  }
  return check.failures;
}

function inspectController(file, source) {
  const check = context(file, source);
  const constructor = check.constructor('CanonicalWorkspaceController');
  if (constructor && !facts(constructor).news.some((entry) => entry.path === 'BbsProjectImportWorkerClient')) {
    check.fail(constructor, 'controller must default project import to BbsProjectImportWorkerClient');
  }
  const save = check.method('CanonicalWorkspaceController', 'saveCanonical3mf');
  if (save)
    check.requireCall(facts(save), 'this.session.save', 'canonical save must retain session health/freshness gates');
  const prepare = check.method('CanonicalWorkspaceController', 'prepareCanonical3mfImport');
  if (prepare) {
    const all = facts(prepare);
    check.requireCall(all, 'this.importCoordinator.prepare', 'canonical import must use its transactional coordinator');
    if (!all.strings.some((entry) => entry.text === 'replace'))
      check.fail(prepare, 'canonical open must prepare replace mode');
  }
  const slice = check.method('CanonicalWorkspaceController', 'createCanonicalSliceSource');
  if (slice) {
    const all = facts(slice);
    if (all.calls.filter((entry) => entry.path === 'this.session.getProjectionHealthSnapshot').length < 2) {
      check.fail(slice, 'slice capture and freshness must both consult projection health');
    }
    check.requireCall(all, 'source.capture', 'slice source must capture canonical store/assets');
    check.requireCall(all, 'source.isCurrent', 'slice source must revalidate canonical store/assets');
    if (!all.news.some((entry) => entry.path === 'UnhealthyProjectProjectionError')) {
      check.fail(slice, 'unhealthy projection must reject canonical slice capture');
    }
  }
  const reset = check.method('CanonicalWorkspaceController', 'resetProject');
  if (reset) {
    const all = facts(reset);
    check.requireCall(
      all,
      'this.session.reset',
      'canonical new project must replace state, assets, and history together',
    );
  }
  return check.failures;
}

function inspectSlicer(file, source) {
  const check = context(file, source);
  const constructor = check.constructor('CanonicalWorkspaceSlicer');
  if (!constructor) return check.failures;
  const all = facts(constructor);
  for (const [name, message] of Object.entries({
    CanonicalSlicerClientRoute: 'compose the canonical client route',
    CanonicalSliceJobCoordinator: 'compose the canonical job coordinator',
    // The archive is authored on a worker, because writing a large plate's core
    // model is seconds of CPU that used to freeze the UI on every slice. The
    // canonical BBS codec is still the only writer: `WorkerProjectSerializer`
    // owns a `Bbs3mfProjectSerializer` on both the worker and the fallback path,
    // which `inspectWorkerSerializer` verifies.
    WorkerProjectSerializer: 'serialize canonical BBS 3MF off the main thread',
    CanonicalStateProfileResolver: 'snapshot effective canonical profiles',
  })) {
    if (!all.news.some((entry) => entry.path === name)) check.fail(constructor, `slicer must ${message}`);
  }
  check.requireCall(all, 'options.workspace.createCanonicalSliceSource', 'slicer must consume only canonical source');
  return check.failures;
}

function inspectWorkerSerializer(file, source) {
  const check = context(file, source);
  const constructor = check.constructor('WorkerProjectSerializer');
  if (!constructor) return check.failures;
  const all = facts(constructor);
  if (!all.news.some((entry) => entry.path === 'Bbs3mfProjectSerializer')) {
    check.fail(constructor, 'worker serializer must fall back to the canonical BBS 3MF codec, never to another format');
  }
  return check.failures;
}

function context(file, source) {
  const failures = [];
  const fail = (node, message) => failures.push(`${file}:${lineOf(source, node)} ${message}`);
  return {
    failures,
    fail,
    method(className, name) {
      const result = findMethod(source, className, name);
      if (!result) fail(source, `must define ${className}.${name} for live-boundary verification`);
      return result;
    },
    constructor(className) {
      const result = findClass(source, className)?.members.find(ts.isConstructorDeclaration);
      if (!result) fail(source, `must define ${className} constructor for live-boundary verification`);
      return result;
    },
    requireCall(all, callPath, message) {
      if (!all.calls.some((entry) => entry.path === callPath)) fail(source, message);
    },
    requireAssignment(all, assignmentPath, message) {
      if (!all.assignments.some((entry) => entry.path === assignmentPath)) fail(source, message);
    },
    forbidCalls(all, rules) {
      forbid(all.calls, rules, fail);
    },
    forbidNews(all, rules) {
      forbid(all.news, rules, fail);
    },
    forbidProperties(all, rules) {
      forbid(all.properties, rules, fail);
    },
  };
}

function forbid(entries, rules, fail) {
  for (const entry of entries) {
    if (Object.hasOwn(rules, entry.path)) fail(entry.node, rules[entry.path]);
  }
}

function facts(root) {
  const result = { calls: [], news: [], properties: [], identifiers: [], assignments: [], strings: [] };
  visit(root, (node) => {
    if (ts.isCallExpression(node)) result.calls.push({ path: expressionPath(node.expression), node });
    if (ts.isNewExpression(node)) result.news.push({ path: expressionPath(node.expression), node });
    if (ts.isPropertyAccessExpression(node)) result.properties.push({ path: expressionPath(node), node });
    if (ts.isIdentifier(node)) result.identifiers.push({ text: node.text, node });
    if (ts.isStringLiteralLike(node)) result.strings.push({ text: node.text, node });
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      result.assignments.push({ path: expressionPath(node.left), node });
    }
  });
  return result;
}

function expressionPath(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (node.kind === ts.SyntaxKind.ThisKeyword) return 'this';
  if (ts.isPropertyAccessExpression(node)) {
    const owner = expressionPath(node.expression);
    return owner ? `${owner}.${node.name.text}` : node.name.text;
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteral(node.argumentExpression)) {
    return `${expressionPath(node.expression)}.${node.argumentExpression.text}`;
  }
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAwaitExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node)
  ) {
    return expressionPath(node.expression);
  }
  return '';
}

function findClass(source, name) {
  let result;
  visit(source, (node) => {
    if (!result && ts.isClassDeclaration(node) && node.name?.text === name) result = node;
  });
  return result;
}

function findMethod(source, className, name) {
  return findClass(source, className)?.members.find(
    (member) => ts.isMethodDeclaration(member) && memberName(member.name) === name && member.body,
  );
}

function memberName(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : '';
}

function assignedIdentifier(expression) {
  let current = expression;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isVariableDeclaration(parent)) return ts.isIdentifier(parent.name) ? parent.name.text : undefined;
    if (
      ts.isAwaitExpression(parent) ||
      ts.isParenthesizedExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isSatisfiesExpression(parent)
    ) {
      current = parent;
    } else return undefined;
  }
  return undefined;
}

function objectArgumentHasPath(call, name, expected) {
  const argument = call.arguments?.[0];
  return Boolean(
    argument &&
    ts.isObjectLiteralExpression(argument) &&
    argument.properties.some(
      (property) =>
        ts.isPropertyAssignment(property) &&
        memberName(property.name) === name &&
        expressionPath(property.initializer) === expected,
    ),
  );
}

function hasRegistryInvocation(all, actionId) {
  return all.calls.some(
    (entry) =>
      entry.path === 'registry.invoke' &&
      entry.node.arguments.length > 0 &&
      ts.isStringLiteralLike(entry.node.arguments[0]) &&
      entry.node.arguments[0].text === actionId,
  );
}

function awaitsCompletion(call) {
  let current = call;
  if (
    current.parent &&
    ts.isPropertyAccessExpression(current.parent) &&
    current.parent.expression === current &&
    current.parent.name.text === 'completion'
  ) {
    current = current.parent;
  }
  while (
    current.parent &&
    (ts.isParenthesizedExpression(current.parent) ||
      ts.isNonNullExpression(current.parent) ||
      ts.isAsExpression(current.parent) ||
      ts.isSatisfiesExpression(current.parent))
  ) {
    current = current.parent;
  }
  return Boolean(current.parent && ts.isAwaitExpression(current.parent));
}

function previewDecision(method, all, callbackPath) {
  const aliases = new Set([callbackPath]);
  visit(method, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      expressionPath(node.initializer) === callbackPath
    ) {
      aliases.add(node.name.text);
    }
  });
  const call = all.calls.find((entry) => aliases.has(entry.path) && entry.node.arguments.length > 0);
  if (!call) return { conditional: false };
  if (inIf(call.node, method)) return { conditional: true };
  const resultName = assignedIdentifier(call.node);
  if (!resultName) return { conditional: false };
  let conditional = false;
  visit(method, (node) => {
    if (ts.isIfStatement(node) && facts(node.expression).identifiers.some((entry) => entry.text === resultName)) {
      conditional = true;
    }
  });
  return { conditional, resultName };
}

function inIf(node, boundary) {
  let current = node;
  while (current.parent && current.parent !== boundary) {
    if (
      ts.isIfStatement(current.parent) &&
      current.parent.expression.pos <= node.pos &&
      current.parent.expression.end >= node.end
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function acknowledgesPreview(all, prepared, decisionName) {
  const argument = all.calls.find((entry) => entry.path === `${prepared}.confirm`)?.node.arguments[0];
  if (!argument) return false;
  if (decisionName && expressionPath(argument) === decisionName) return true;
  if (!ts.isObjectLiteralExpression(argument)) return false;
  const properties = new Map(
    argument.properties
      .filter(ts.isPropertyAssignment)
      .map((property) => [memberName(property.name), property.initializer]),
  );
  const acknowledgement = properties.get('acknowledgedNoticeIds');
  const acknowledgementPath = acknowledgement ? expressionPath(acknowledgement) : '';
  return Boolean(
    properties.get('confirmed')?.kind === ts.SyntaxKind.TrueKeyword &&
    (acknowledgementPath.endsWith('.requiredAcknowledgementIds') ||
      acknowledgementPath.endsWith('.acknowledgedNoticeIds') ||
      acknowledgementPath === 'acknowledgedNoticeIds'),
  );
}

function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function readSourceTree(root, relativeDirectory) {
  const directory = path.join(root, relativeDirectory);
  if (!fs.existsSync(directory)) return [];
  const result = [];
  const visitDirectory = (current) => {
    for (const entry of fs
      .readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') visitDirectory(target);
      } else if (
        entry.isFile() &&
        (target.endsWith('.ts') || target.endsWith('.js')) &&
        !target.endsWith('.test.ts') &&
        !target.endsWith('.test.js')
      ) {
        const relative = path.relative(root, target).split(path.sep).join('/');
        result.push([relative, parse(relative, fs.readFileSync(target, 'utf8'))]);
      }
    }
  };
  visitDirectory(directory);
  return result;
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}
