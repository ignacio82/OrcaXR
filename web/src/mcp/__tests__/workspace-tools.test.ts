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
const actionContext = {
  ui,
  applyTool: (tool: ToolName) => applied.push(tool),
  reportCapabilityUnavailable: (label: string, reason: string) => reports.push(`${label}: ${reason}`),
} as unknown as ActionContext;
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

const paintResult = (await setGizmoTool({ tool: 'paint' })) as {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};
assert.equal(paintResult.isError, true);
assert.deepEqual(applied, ['move'], 'an unavailable paint tool must not reach the handler');
assert.match(paintResult.content[0]?.text ?? '', /canonical facet annotations/i);
assert.match(reports.at(-1) ?? '', /Paint: .*canonical facet annotations/i);

const source = readFileSync(fileURLToPath(new URL('../WorkspaceTools.ts', import.meta.url)), 'utf8');
assert.doesNotMatch(source, /workspace\.setTool\s*\(/);
assert.match(source, /registry\.invoke\(actionId, 'automation'/);

console.log('workspace-tools tests passed');
