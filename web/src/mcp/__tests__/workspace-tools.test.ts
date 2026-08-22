import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ActionContext, ToolName } from '../../actions/ActionContext';
import { UiState } from '../../actions/UiState';
import { buildRegistry } from '../../actions/catalog';
import type { OrcaWorkspace } from '../../workspace/OrcaWorkspace';
import type { McpToolHandler, McpToolHost, McpToolInputSchema } from '../McpToolHost';
import { registerWorkspaceTools } from '../WorkspaceTools';

class FakeToolHost implements McpToolHost {
  readonly handlers = new Map<string, McpToolHandler>();

  registerTool(name: string, _description: string, _inputSchema: McpToolInputSchema, handler: McpToolHandler): void {
    this.handlers.set(name, handler);
  }
}

const host = new FakeToolHost();
const registry = buildRegistry();
const ui = new UiState();
ui.update({ modelCount: 1, hasSelection: true, hasInstanceSelection: true });

const applied: ToolName[] = [];
const reports: string[] = [];
const assignments: Array<{ entities: unknown; filamentId: unknown; guard: unknown }> = [];
const actionContext = {
  ui,
  applyTool: (tool: ToolName) => applied.push(tool),
  reportCapabilityUnavailable: (label: string, reason: string) => reports.push(`${label}: ${reason}`),
  assignObjectsTreeFilament: (entities: unknown, filamentId: unknown, guard: unknown) => {
    assignments.push({ entities, filamentId, guard });
  },
} as unknown as ActionContext;
let assignmentScopes: unknown[] = [
  { entity: { kind: 'object', id: 'object-1' }, objectId: 'object-1', label: 'Wedge' },
];
const filamentOptions = [
  {
    id: 'filament-matte',
    kind: 'physical',
    name: 'Snapmaker PLA Matte',
    color: '#1e88e5',
    enabled: true,
    material: 'PLA',
    toolId: 0,
    recipe: [],
    warnings: [],
  },
  {
    id: 'filament-speed',
    kind: 'physical',
    name: 'Snapmaker PLA SnapSpeed',
    color: '#e2dedb',
    enabled: true,
    material: 'PLA',
    toolId: 1,
    recipe: [],
    warnings: [],
  },
  {
    id: 'filament-empty',
    kind: 'physical',
    name: 'Unloaded head',
    color: '#333333',
    enabled: false,
    material: 'PETG',
    toolId: 2,
    recipe: [],
    warnings: [],
  },
];
const workspace = {
  getAutomationSnapshot: () => ({
    workspaceMode: 'Prepare',
    activePlateId: 'plate-1',
    gizmoTool: 'move',
    selectedProfileId: null,
    placedModelsTotalAllPlates: 1,
    plates: [],
    placedModels: [],
  }),
  getFilamentAssignmentSnapshot: () => ({
    sourceRevision: 4,
    sourceHash: 'hash-4',
    scopes: assignmentScopes,
    unsupportedSelection: [],
    options: filamentOptions,
  }),
  setTool: () => {
    throw new Error('MCP must not mutate the workspace directly');
  },
} as unknown as OrcaWorkspace;

registerWorkspaceTools(host, workspace, registry, actionContext);
const setGizmoTool = host.handlers.get('set_gizmo_tool');
assert.ok(setGizmoTool, 'set_gizmo_tool was not registered');

const moveResult = (await setGizmoTool({ tool: 'move' })) as {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
assert.equal(moveResult.isError, undefined);
assert.deepEqual(applied, ['move']);
assert.match(moveResult.content[0]?.text ?? '', /set to move/);

// Colour painting is a canonical tool now, so automation reaches its handler.
const paintResult = (await setGizmoTool({ tool: 'paint' })) as {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
assert.equal(paintResult.isError, undefined);
assert.deepEqual(applied, ['move', 'paint']);

// Lay flat is canonical now and reaches its handler.
const layFlatResult = (await setGizmoTool({ tool: 'lay_on_face' })) as {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
assert.equal(layFlatResult.isError, undefined);
assert.deepEqual(applied, ['move', 'paint', 'lay_on_face']);

// A tool that is still gated must fail visibly instead of reaching the handler.
const cutResult = (await setGizmoTool({ tool: 'cut' })) as {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
assert.equal(cutResult.isError, true);
assert.deepEqual(applied, ['move', 'paint', 'lay_on_face'], 'an unknown or gated tool never reaches the handler');

// "Make the selected model the blue one" is the same canonical action the chip
// bar presses, reachable by head number or by name.
const assign = host.handlers.get('assign_filament_to_selection');
assert.ok(assign, 'assign_filament_to_selection was not registered');

const byHead = (await assign({ filament: '2' })) as { content: Array<{ text: string }>; isError?: boolean };
assert.equal(byHead.isError, undefined);
assert.equal(assignments.length, 1);
assert.equal(assignments[0].filamentId, 'filament-speed');
assert.deepEqual(assignments[0].entities, [{ kind: 'object', id: 'object-1' }]);
assert.equal((assignments[0].guard as { sourceRevision: number }).sourceRevision, 4);
assert.equal((assignments[0].guard as { sourceHash: string }).sourceHash, 'hash-4');
assert.match(byHead.content[0]?.text ?? '', /Assigned Snapmaker PLA SnapSpeed to Wedge/);

const byName = (await assign({ filament: 'matte' })) as { content: Array<{ text: string }>; isError?: boolean };
assert.equal(byName.isError, undefined);
assert.equal(assignments[1].filamentId, 'filament-matte');

const cleared = (await assign({})) as { content: Array<{ text: string }>; isError?: boolean };
assert.equal(cleared.isError, undefined);
assert.equal(assignments[2].filamentId, null, 'no filament named is a request to clear, not a guess');

// Everything ambiguous, unloaded, unknown, or unselectable fails closed and
// says what is actually loaded.
const ambiguous = (await assign({ filament: 'Snapmaker PLA' })) as {
  content: Array<{ text: string }>;
  isError?: boolean;
};
assert.equal(ambiguous.isError, true);
assert.match(ambiguous.content[0]?.text ?? '', /matches 2 filaments/);
assert.match(ambiguous.content[0]?.text ?? '', /Loaded filaments: 1: Snapmaker PLA Matte/);
assert.equal(assignments.length, 3, 'an ambiguous request assigns nothing');

const unloaded = (await assign({ filament: '3' })) as { content: Array<{ text: string }>; isError?: boolean };
assert.equal(unloaded.isError, true);
assert.match(unloaded.content[0]?.text ?? '', /carries no loaded filament/);

const unknown = (await assign({ filament: 'Nebula' })) as { content: Array<{ text: string }>; isError?: boolean };
assert.equal(unknown.isError, true);
assert.match(unknown.content[0]?.text ?? '', /No loaded filament matches/);

assignmentScopes = [];
const nothingSelected = (await assign({ filament: '1' })) as { content: Array<{ text: string }>; isError?: boolean };
assert.equal(nothingSelected.isError, true);
assert.match(nothingSelected.content[0]?.text ?? '', /select an object, part, or height range first/);
assert.equal(assignments.length, 3, 'an unassignable selection assigns nothing');

const source = readFileSync(fileURLToPath(new URL('../WorkspaceTools.ts', import.meta.url)), 'utf8');
assert.doesNotMatch(source, /workspace\.setTool\s*\(/);
assert.match(source, /registry\.invoke\(actionId, 'automation'/);

console.log('workspace-tools tests passed');
