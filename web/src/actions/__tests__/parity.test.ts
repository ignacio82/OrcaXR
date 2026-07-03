/**
 * Parity test (run: npx tsx parity.test.ts).
 *
 * Guards the two invariants the shared-registry architecture exists to protect:
 *
 *  1. Shell parity — every non-inspector action resolves to an explicit glyph in
 *     BOTH the `xr` and `dom` icon maps, so the DOM shell and the (registry-driven)
 *     XR shell can render the identical action set. Adding an action without a
 *     both-shell icon fails here.
 *  2. MCP parity — every action's `mcpTool` is a real member of the canonical
 *     Android MCP tool surface (extracted live from the Kotlin sources), so the
 *     web UI can't drift a button onto a tool that doesn't exist, and the core
 *     capabilities stay mapped to the catalogue.
 *
 * Also locks in the Phase-5 cleanup: no orphaned `*Panel.ts` view files remain.
 */
import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildRegistry } from '../catalog';
import { GROUPS } from '../ActionRegistry';
import { hasIcon } from '../../ui/icons';

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed++; console.log('  ✓', name); }

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** Recursively collect every MCP tool name declared as `name = "…"` in Kotlin. */
function extractMcpToolNames(): Set<string> {
  const dir = `${repoRoot}app/src/main/java/dev/orcaxr/app/mcp`;
  const names = new Set<string>();
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = `${d}/${e.name}`;
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.kt')) {
        const src = readFileSync(full, 'utf8');
        for (const m of src.matchAll(/name\s*=\s*"([a-z0-9_]+)"/g)) names.add(m[1]);
      }
    }
  };
  walk(dir);
  return names;
}

const registry = buildRegistry();
const actions = registry.all();
const mcp = extractMcpToolNames();

test('MCP surface extracts the full canonical catalogue', () => {
  // The project treats 163 tools as canonical; guard against a broken extraction.
  assert.ok(mcp.size >= 150, `expected >=150 MCP tools, got ${mcp.size}`);
});

test('every action maps to a REAL MCP tool (no drift)', () => {
  const bad = actions.filter((a) => a.mcpTool && !mcp.has(a.mcpTool));
  assert.deepStrictEqual(bad.map((a) => `${a.id}→${a.mcpTool}`), [],
    'actions reference non-existent MCP tools');
});

test('core capabilities are mapped to the MCP catalogue', () => {
  // These must never silently lose their tie to the canonical surface.
  const mustMap = [
    'load_model_from_path', 'slice_active_plate', 'save_gcode_to_downloads',
    'repair_model', 'simplify_model', 'delete_models',
    'add_handy_model', 'add_primitive_cube', 'mesh_boolean_union',
  ];
  for (const id of mustMap) {
    const a = registry.get(id);
    assert.ok(a, `missing action ${id}`);
    assert.ok(a!.mcpTool && mcp.has(a!.mcpTool), `${id} not mapped to a real MCP tool`);
  }
});

test('every non-inspector action renders in BOTH shells (icon in xr + dom)', () => {
  const unrenderable = actions
    .filter((a) => a.disclosure !== 'inspector')
    .filter((a) => !hasIcon(a.icon))
    .map((a) => `${a.id} (icon:${a.icon})`);
  assert.deepStrictEqual(unrenderable, [], 'actions lack a both-shell icon glyph');
});

test('group icons also resolve in both shells', () => {
  const missing = GROUPS.filter((g) => !hasIcon(g.icon)).map((g) => g.id);
  assert.deepStrictEqual(missing, [], 'groups lack a both-shell icon glyph');
});

test('no orphaned *Panel.ts view files remain (Phase 5 cleanup)', () => {
  const wsDir = `${here}../../workspace`;
  const panels = readdirSync(wsDir).filter((f) => f.endsWith('Panel.ts'));
  assert.deepStrictEqual(panels, [], `stale Panel view files: ${panels.join(', ')}`);
});

console.log(`\nParity: ${passed} tests passed. (${actions.length} actions, ${mcp.size} MCP tools)`);
