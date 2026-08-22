import type { ActionContext } from '../actions/ActionContext';
import type { ActionRegistry } from '../actions/ActionRegistry';
import type { OrcaWorkspace, WorkspaceGizmoTool } from '../workspace/OrcaWorkspace';
import type { FilamentId } from '../project/domain/ids';
import type { CanonicalFilamentOption } from '../workspace/CanonicalWorkspaceController';
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
  emboss: 'add_emboss',
  svg: 'tool_svg',
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

  // The flat bar, the XR row, and this tool are three ways to press the same
  // canonical action, so "make the selected model the blue one" is reachable
  // from a sentence exactly as it is from a chip.
  mcp.registerTool(
    'assign_filament_to_selection',
    "Assign one of the printer's loaded filaments to the current selection. Identify it by head number " +
      '("1") or by name ("Snapmaker PLA Matte"). Omit it, or pass "default", to clear the local assignment ' +
      'so the selection follows its object default.',
    {
      type: 'object',
      properties: {
        filament: {
          type: 'string',
          description: 'Head number, filament name, or "default" to clear the local assignment.',
        },
      },
      additionalProperties: false,
    },
    async function (args: McpToolArguments) {
      const snapshot = workspace.getFilamentAssignmentSnapshot();
      const catalogue = snapshot.options
        .map((option) =>
          option.kind === 'physical' && option.toolId !== undefined
            ? `${option.toolId + 1}: ${option.name}${option.enabled ? '' : ' (unloaded)'}`
            : `${option.name} (mixed)`,
        )
        .join(', ');
      if (snapshot.scopes.length === 0 || snapshot.unsupportedSelection.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text: 'Error: select an object, part, or height range first — the current selection cannot take a filament.',
            },
          ],
          isError: true,
        };
      }

      const requested = typeof args.filament === 'string' ? args.filament.trim() : '';
      const resolution = resolveRequestedFilament(snapshot.options, requested);
      if (resolution.error) {
        return {
          content: [{ type: 'text', text: `Error: ${resolution.error} Loaded filaments: ${catalogue}.` }],
          isError: true,
        };
      }

      const state = actionContext.ui.get();
      const availability = registry.availability('objects_assign_filament', 'automation', state);
      const invoked = await registry.invoke('objects_assign_filament', 'automation', actionContext, state, {
        objectsFilamentAssignment: {
          entities: snapshot.scopes.map((scope) => scope.entity),
          filamentId: resolution.filamentId ?? null,
          sourceRevision: snapshot.sourceRevision,
          sourceHash: snapshot.sourceHash,
        },
      });
      if (!invoked) {
        const reason = availability.state === 'enabled' ? 'The action did not run.' : availability.reason;
        return { content: [{ type: 'text', text: `Error: ${reason}` }], isError: true };
      }
      const scopeNames = snapshot.scopes.map((scope) => scope.label).join(', ');
      return {
        content: [
          {
            type: 'text',
            text: resolution.name
              ? `Assigned ${resolution.name} to ${scopeNames}.`
              : `Cleared the local filament assignment on ${scopeNames}.`,
          },
        ],
      };
    },
  );
}

/**
 * Turn what a sentence said into one stable filament identity, or say why it
 * could not. A request that matches several filaments is refused rather than
 * resolved to whichever came first.
 */
function resolveRequestedFilament(
  options: readonly CanonicalFilamentOption[],
  requested: string,
): { filamentId?: FilamentId; name?: string; error?: string } {
  if (!requested || requested.toLowerCase() === 'default' || requested.toLowerCase() === 'inherit') return {};

  const head = Number.parseInt(requested, 10);
  if (String(head) === requested) {
    const byHead = options.find((option) => option.kind === 'physical' && option.toolId === head - 1);
    if (!byHead) return { error: `No head ${head} is configured.` };
    if (!byHead.enabled) return { error: `Head ${head} carries no loaded filament.` };
    return { filamentId: byHead.id, name: byHead.name };
  }

  const wanted = requested.toLowerCase();
  const exact = options.filter((option) => option.name.toLowerCase() === wanted);
  const partial = exact.length > 0 ? exact : options.filter((option) => option.name.toLowerCase().includes(wanted));
  if (partial.length === 0) return { error: `No loaded filament matches ${JSON.stringify(requested)}.` };
  if (partial.length > 1) {
    return {
      error: `${JSON.stringify(requested)} matches ${partial.length} filaments; name one exactly.`,
    };
  }
  if (!partial[0].enabled) return { error: `${partial[0].name} is not loaded.` };
  return { filamentId: partial[0].id, name: partial[0].name };
}
