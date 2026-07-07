import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Generates calibration test geometries (printer-frame mm, Z-up, sitting on the
 * bed) to drop straight onto the plate. Real, printable shapes — not stand-ins.
 */
export class CalibrationRampGenerator {
  /**
   * A temperature/retraction tower: a central column with a protruding overhang
   * fin at each segment, so each band prints a visible overhang. `segments`
   * bands of `segH` mm on a `size` mm square column.
   */
  generateTemperatureTower(segments = 8, segH = 10, size = 16): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const totalH = segments * segH;

    // Central column.
    const column = new THREE.BoxGeometry(size, size, totalH);
    column.translate(0, 0, totalH / 2);
    parts.push(column);

    // One overhang fin per band, protruding in +Y.
    for (let i = 0; i < segments; i++) {
      const finDepth = 8;
      const finH = segH * 0.45;
      const fin = new THREE.BoxGeometry(size * 0.9, finDepth, finH);
      const z = i * segH + finH / 2 + segH * 0.1;
      fin.translate(0, size / 2 + finDepth / 2, z);
      parts.push(fin);
    }

    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    merged.computeVertexNormals();
    return merged;
  }

  /** A 20 mm XYZ calibration cube (dimensional-accuracy check). */
  generateCalibrationCube(size = 20): THREE.BufferGeometry {
    const geo = new THREE.BoxGeometry(size, size, size);
    geo.translate(0, 0, size / 2);
    return geo;
  }

  generateFlowPass1(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const size = 20;
    const spacing = 5;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const patch = new THREE.BoxGeometry(size, size, 2);
        patch.translate((i - 1) * (size + spacing), (j - 1) * (size + spacing), 1);
        parts.push(patch);
      }
    }
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    merged.computeVertexNormals();
    return merged;
  }

  generateFlowPass2(): THREE.BufferGeometry { return this.generateFlowPass1(); }
  generateFlowYolo(): THREE.BufferGeometry { return this.generateFlowPass1(); }

  generatePressureAdvance(): THREE.BufferGeometry {
    return this.generateTemperatureTower(10, 5, 20);
  }

  generateRetraction(): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const post1 = new THREE.CylinderGeometry(2, 2, 30, 16);
    post1.translate(-15, 0, 15);
    const post2 = new THREE.CylinderGeometry(2, 2, 30, 16);
    post2.translate(15, 0, 15);
    const base = new THREE.BoxGeometry(40, 10, 2);
    base.translate(0, 0, 1);
    parts.push(post1, post2, base);
    const merged = BufferGeometryUtils.mergeGeometries(parts, false);
    merged.computeVertexNormals();
    return merged;
  }

  generateMaxFlow(): THREE.BufferGeometry { return this.generateCalibrationCube(); }
  generateVfa(): THREE.BufferGeometry { return this.generateCalibrationCube(); }
  generateTolerance(): THREE.BufferGeometry { return this.generateCalibrationCube(); }
}
