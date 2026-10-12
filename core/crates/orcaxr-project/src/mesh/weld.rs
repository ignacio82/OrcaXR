//! `weldTriangleMesh` (`meshWeld.ts`): a triangle list welded into one closed
//! surface before it is stored. Generated geometry arrives as a triangle soup
//! whose wrapped shapes repeat their seam vertices with float noise, which
//! the pinned engine cannot slice; corners within 1e-6 mm become one vertex
//! (the rule extruded text and SVG parts use), each keeping its first
//! corner's coordinates in the order the triangles name them. Every triangle
//! is kept in its order; a vertex no triangle names is dropped.
use crate::js_math;
use std::collections::HashMap;

/// The welded positions and the triangles' indices into them. `indices`
/// must name vertices of `positions` (three coordinates each).
pub fn weld(positions: &[f32], indices: &[u32]) -> (Vec<f32>, Vec<u32>) {
    // The browser keys on the decimal spelling of each rounded value, so -0
    // and 0 are one key; every value here is finite.
    let part = |value: f32| {
        let rounded = js_math::round(f64::from(value) * 1e6);
        if rounded == 0.0 { 0 } else { rounded.to_bits() }
    };
    let mut by_key: HashMap<[u64; 3], u32> = HashMap::new();
    let mut welded = Vec::new();
    let remapped = indices
        .iter()
        .map(|&corner| {
            let at = corner as usize * 3;
            let [x, y, z] = [positions[at], positions[at + 1], positions[at + 2]];
            *by_key
                .entry([part(x), part(y), part(z)])
                .or_insert_with(|| {
                    welded.extend([x, y, z]);
                    (welded.len() / 3 - 1) as u32
                })
        })
        .collect();
    (welded, remapped)
}

#[cfg(test)]
mod tests {
    use super::weld;

    #[test]
    fn corners_within_a_micron_become_one_vertex() {
        // Two triangles sharing an edge, one corner repeated with float noise
        // and one negative zero; an unnamed vertex is dropped.
        let positions = [
            0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, // first
            1.0, 1.2e-15, 0.0, 1.0, 1.0, 0.0, -0.0, 1.0, 0.0, // second
            9.0, 9.0, 9.0, // unnamed
        ];
        let (welded, indices) = weld(&positions, &[0, 1, 2, 3, 4, 5]);
        assert_eq!(
            welded,
            [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0]
        );
        assert_eq!(indices, [0, 1, 2, 1, 3, 2]);
        // 2e-6 mm apart is two vertices.
        let (apart, _) = weld(&[0.0, 0.0, 0.0, 2e-6, 0.0, 0.0, 0.0, 1.0, 0.0], &[0, 1, 2]);
        assert_eq!(apart.len(), 9);
    }
}
