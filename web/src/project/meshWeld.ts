/**
 * One closed surface from a generated triangle list.
 *
 * Three's generators and loaders hand a geometry over as a triangle soup:
 * `toNonIndexed()` gives every triangle its own three vertices, and the shapes
 * that wrap around — a cylinder, a cone, a sphere, a torus — repeat their seam
 * vertices with coordinates that differ by float noise (`sin(2π)` is not 0).
 * Stored that way, no two triangles share a vertex, the archive's mesh has an
 * open edge everywhere, and the pinned engine cannot slice the shape: a 20 mm
 * cylinder, cone, sphere or disc reports "The print is empty", and a torus
 * loses most of its layers. Only a cube survived, by its flat faces.
 *
 * So a mesh is welded before it is stored: corners within 1e-6 mm become one
 * vertex — far below any printable feature, far above float noise, the same
 * rule extruded text and SVG parts use (`extrude.ts`'s `VertexWelder`). Each
 * vertex keeps its first corner's coordinates, in the order the triangles name
 * their corners, so one geometry always yields identical bytes; every triangle
 * is kept, in its order, so a triangle index means the same face before and
 * after. A vertex no triangle names is not kept.
 */
export function weldTriangleMesh(
  positions: Float32Array,
  indices: Uint32Array,
): { positions: Float32Array; indices: Uint32Array } {
  const byKey = new Map<string, number>();
  const welded: number[] = [];
  const remapped = new Uint32Array(indices.length);
  for (let corner = 0; corner < indices.length; corner += 1) {
    const offset = indices[corner] * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    let vertex = byKey.get(key);
    if (vertex === undefined) {
      vertex = welded.length / 3;
      welded.push(x, y, z);
      byKey.set(key, vertex);
    }
    remapped[corner] = vertex;
  }
  return { positions: Float32Array.from(welded), indices: remapped };
}
