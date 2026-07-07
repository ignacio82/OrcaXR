import * as THREE from 'three';
import { OrcaWorkspace } from '../workspace/OrcaWorkspace';

export function registerWorkspaceTools(mcp: any, workspace: OrcaWorkspace) {
    mcp.registerTool(
        'get_workspace_state',
        'Snapshot the entire in-session workspace.',
        {},
        async function() {
            const plates = workspace.getPlates();
            const activePlateId = plates.find(p => p.active)?.id || 1;
            const models = (workspace as any).models || [];
            
            const state = {
                workspace_mode: (workspace as any).previewOn ? 'Preview' : 'Prepare',
                active_plate_id: activePlateId,
                gizmo_tool: (workspace as any).tool || 'move',
                selected_profile: (workspace as any).profile?.id,
                placed_models_total_all_plates: plates.reduce((sum, p) => sum + p.count, 0),
                placed_models: models.map((m: any, i: number) => ({
                    id: m.viewer.uuid,
                    label: m.viewer.name || `Model ${i}`,
                    plate_id: activePlateId,
                    translate_x_mm: m.viewer.position.x,
                    translate_y_mm: m.viewer.position.y,
                    translate_z_mm: m.viewer.position.z,
                    rot_x_deg: THREE.MathUtils.radToDeg(m.viewer.rotation.x),
                    rot_y_deg: THREE.MathUtils.radToDeg(m.viewer.rotation.y),
                    rot_z_deg: THREE.MathUtils.radToDeg(m.viewer.rotation.z),
                    scale_x_pct: m.viewer.scale.x * 100,
                    scale_y_pct: m.viewer.scale.y * 100,
                    scale_z_pct: m.viewer.scale.z * 100
                }))
            };

            const text = `Workspace: ${state.workspace_mode}\nActive plate: ${state.active_plate_id} (${models.length} models on plate)\nGizmo: ${state.gizmo_tool}\n`;

            return {
                content: [{
                    type: "text",
                    text: text + "\n```json\n" + JSON.stringify(state, null, 2) + "\n```"
                }]
            };
        }
    );

    mcp.registerTool(
        'set_gizmo_tool',
        'Switch the active transform tool. Options: move, rotate, scale, paint, lay_on_face',
        {
            tool: {
                type: 'string',
                description: 'One of: move, rotate, scale, paint, lay_on_face'
            }
        },
        async function(args: any) {
            const tool = args.tool;
            if (!['move', 'rotate', 'scale', 'paint', 'lay_on_face'].includes(tool)) {
                return {
                    content: [{ type: "text", text: `Error: Unknown tool '${tool}'` }]
                };
            }
            workspace.setTool(tool as any);
            return {
                content: [{ type: "text", text: `Gizmo tool set to ${tool}` }]
            };
        }
    );
}
