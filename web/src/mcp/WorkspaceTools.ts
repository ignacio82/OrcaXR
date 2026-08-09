import type { ActionContext } from '../actions/ActionContext';
import type { ActionRegistry } from '../actions/ActionRegistry';
import type { OrcaWorkspace, WorkspaceGizmoTool } from '../workspace/OrcaWorkspace';
import type { McpToolArguments, McpToolHost } from './McpToolHost';

const GIZMO_TOOLS: readonly WorkspaceGizmoTool[] = ['move', 'rotate', 'scale', 'paint', 'lay_on_face'];
const ACTION_ID_BY_GIZMO_TOOL = {
  move: 'tool_move',
  rotate: 'tool_rotate',
  scale: 'tool_scale',
  paint: 'tool_paint',
  support_paint: 'tool_support_paint',
  seam_paint: 'tool_seam_paint',
  fuzzy_skin: 'tool_fuzzy_skin',
  lay_on_face: 'tool_lay_on_face',
  measure: 'tool_measure',
  brim_ears: 'tool_brim_ears',
} as const satisfies Readonly<Record<WorkspaceGizmoTool, string>>;

function isGizmoTool(value: unknown): value is WorkspaceGizmoTool {
  return typeof value === 'string' && GIZMO_TOOLS.includes(value as WorkspaceGizmoTool);
}

export function registerWorkspaceTools(
  mcp: McpToolHost,
  workspace: OrcaWorkspace,
  registry: ActionRegistry,
  actionContext: ActionContext,
) {
  mcp.registerTool(
    'get_workspace_state',
    'Snapshot the entire in-session workspace.',
    { type: 'object', properties: {}, additionalProperties: false },
    async function () {
      const snapshot = workspace.getAutomationSnapshot();
      const state = {
        workspace_mode: snapshot.workspaceMode,
        active_plate_id: snapshot.activePlateId,
        gizmo_tool: snapshot.gizmoTool,
        selected_profile: snapshot.selectedProfileId,
        placed_models_total_all_plates: snapshot.placedModelsTotalAllPlates,
        plates: snapshot.plates,
        placed_models: snapshot.placedModels.map((model) => ({
          id: model.id,
          label: model.label,
          plate_id: model.plateId,
          translate_x_mm: model.translateXmm,
          translate_y_mm: model.translateYmm,
          translate_z_mm: model.translateZmm,
          rot_x_deg: model.rotXDeg,
          rot_y_deg: model.rotYDeg,
          rot_z_deg: model.rotZDeg,
          scale_x_pct: model.scaleXPct,
          scale_y_pct: model.scaleYPct,
          scale_z_pct: model.scaleZPct,
        })),
      };

      const text = `Workspace: ${state.workspace_mode}\nActive plate: ${state.active_plate_id} (${state.placed_models.length} models on plate)\nGizmo: ${state.gizmo_tool}\n`;

      return {
        content: [
          {
            type: 'text',
            text: text + '\n```json\n' + JSON.stringify(state, null, 2) + '\n```',
          },
        ],
      };
    },
  );

  mcp.registerTool(
    'set_gizmo_tool',
    'Switch the active transform tool. Options: move, rotate, scale, paint, lay_on_face',
    {
      type: 'object',
      properties: {
        tool: {
          type: 'string',
          description: 'The transform or paint tool to activate.',
          enum: GIZMO_TOOLS,
        },
      },
      required: ['tool'],
      additionalProperties: false,
    },
    async function (args: McpToolArguments) {
      const tool = args.tool;
      if (!isGizmoTool(tool)) {
        return {
          content: [{ type: 'text', text: 'Error: tool must be move, rotate, scale, paint, or lay_on_face.' }],
          isError: true,
        };
      }
      const actionId = ACTION_ID_BY_GIZMO_TOOL[tool];
      const state = actionContext.ui.get();
      const availability = registry.availability(actionId, 'automation', state);
      const invoked = await registry.invoke(actionId, 'automation', actionContext, state);
      if (!invoked) {
        const reason = availability.state === 'enabled' ? 'The action did not run.' : availability.reason;
        return {
          content: [{ type: 'text', text: `Error: ${reason}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: `Gizmo tool set to ${tool}` }],
      };
    },
  );
}
