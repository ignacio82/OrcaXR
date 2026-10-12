//! three.js r184's vector, quaternion, matrix, camera and ray arithmetic as
//! `TransformControls` uses it, operation for operation: every expression
//! keeps three's operand order (so roundings and signed zeros agree), and the
//! transcendental functions are V8's ([`crate::js_math`]). Matrices are
//! column-major `Matrix4.elements`; quaternions `[x, y, z, w]`.
use crate::js_math::{self, acos, cos, sin, tan};
pub use crate::picking::{Matrix, apply, invert, multiply};

pub type Vec3 = [f64; 3];
pub type Quat = [f64; 4];

/// `new Quaternion()`.
pub const IDENTITY_QUATERNION: Quat = [0.0, 0.0, 0.0, 1.0];
/// `new Matrix4()`.
pub const IDENTITY: Matrix = [
    1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
];
pub const UNIT_X: Vec3 = [1.0, 0.0, 0.0];
pub const UNIT_Y: Vec3 = [0.0, 1.0, 0.0];
pub const UNIT_Z: Vec3 = [0.0, 0.0, 1.0];
pub const ZERO: Vec3 = [0.0, 0.0, 0.0];

/// `Vector3.add`.
pub fn add(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
/// `Vector3.sub` / `subVectors(a, b)`.
pub fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
/// `Vector3.multiplyScalar`.
pub fn scale(a: Vec3, s: f64) -> Vec3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
/// `Vector3.multiply`.
pub fn multiply_components(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}
/// `Vector3.divide`.
pub fn divide_components(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] / b[0], a[1] / b[1], a[2] / b[2]]
}
/// `Vector3.dot` (and `lengthSq` of a vector with itself).
pub fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
/// `Vector3.length`.
pub fn length(a: Vec3) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}
/// `Vector3.crossVectors(a, b)`.
pub fn cross(a: Vec3, b: Vec3) -> Vec3 {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}
/// `Vector3.normalize`: `divideScalar(length() || 1)`.
pub fn normalize(a: Vec3) -> Vec3 {
    let length = length(a);
    let divisor = if length == 0.0 || length.is_nan() {
        1.0
    } else {
        length
    };
    scale(a, 1.0 / divisor)
}
/// `Vector3.distanceToSquared`.
pub fn distance_squared(a: Vec3, b: Vec3) -> f64 {
    let (dx, dy, dz) = (a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    dx * dx + dy * dy + dz * dz
}
/// `Vector3.distanceTo`.
pub fn distance(a: Vec3, b: Vec3) -> f64 {
    distance_squared(a, b).sqrt()
}
/// `Vector3.lerp(v, alpha)`.
pub fn lerp(a: Vec3, b: Vec3, alpha: f64) -> Vec3 {
    [
        a[0] + (b[0] - a[0]) * alpha,
        a[1] + (b[1] - a[1]) * alpha,
        a[2] + (b[2] - a[2]) * alpha,
    ]
}
/// `MathUtils.clamp`: `Math.max(min, Math.min(max, value))`.
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    js_math::max(min, js_math::min(max, value))
}
/// `Vector3.angleTo`.
pub fn angle_to(a: Vec3, b: Vec3) -> f64 {
    let denominator = (dot(a, a) * dot(b, b)).sqrt();
    if denominator == 0.0 {
        return std::f64::consts::PI / 2.0;
    }
    let theta = dot(a, b) / denominator;
    acos(clamp(theta, -1.0, 1.0))
}
/// `Vector3.applyQuaternion`.
pub fn apply_quaternion(v: Vec3, q: Quat) -> Vec3 {
    let [vx, vy, vz] = v;
    let [qx, qy, qz, qw] = q;
    let tx = 2.0 * (qy * vz - qz * vy);
    let ty = 2.0 * (qz * vx - qx * vz);
    let tz = 2.0 * (qx * vy - qy * vx);
    [
        vx + qw * tx + qy * tz - qz * ty,
        vy + qw * ty + qz * tx - qx * tz,
        vz + qw * tz + qx * ty - qy * tx,
    ]
}
/// `Vector3.transformDirection`.
pub fn transform_direction(v: Vec3, e: &Matrix) -> Vec3 {
    let [x, y, z] = v;
    normalize([
        e[0] * x + e[4] * y + e[8] * z,
        e[1] * x + e[5] * y + e[9] * z,
        e[2] * x + e[6] * y + e[10] * z,
    ])
}

/// `Quaternion.invert` (`conjugate`: `x *= -1`, which is negation).
pub fn conjugate(q: Quat) -> Quat {
    [-q[0], -q[1], -q[2], q[3]]
}
/// `Quaternion.multiplyQuaternions(a, b)`.
pub fn quat_multiply(a: Quat, b: Quat) -> Quat {
    let [qax, qay, qaz, qaw] = a;
    let [qbx, qby, qbz, qbw] = b;
    [
        qax * qbw + qaw * qbx + qay * qbz - qaz * qby,
        qay * qbw + qaw * qby + qaz * qbx - qax * qbz,
        qaz * qbw + qaw * qbz + qax * qby - qay * qbx,
        qaw * qbw - qax * qbx - qay * qby - qaz * qbz,
    ]
}
/// `Quaternion.normalize`.
pub fn quat_normalize(q: Quat) -> Quat {
    let l = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if l == 0.0 {
        IDENTITY_QUATERNION
    } else {
        let l = 1.0 / l;
        [q[0] * l, q[1] * l, q[2] * l, q[3] * l]
    }
}
/// `Quaternion.setFromAxisAngle`.
pub fn from_axis_angle(axis: Vec3, angle: f64) -> Quat {
    let half = angle / 2.0;
    let s = sin(half);
    [axis[0] * s, axis[1] * s, axis[2] * s, cos(half)]
}
/// `Quaternion.setFromEuler` of an XYZ `Euler`, unnormalized.
pub fn from_euler(angles: Vec3) -> Quat {
    let [x, y, z] = angles;
    let (c1, c2, c3) = (cos(x / 2.0), cos(y / 2.0), cos(z / 2.0));
    let (s1, s2, s3) = (sin(x / 2.0), sin(y / 2.0), sin(z / 2.0));
    [
        s1 * c2 * c3 + c1 * s2 * s3,
        c1 * s2 * c3 - s1 * c2 * s3,
        c1 * c2 * s3 + s1 * s2 * c3,
        c1 * c2 * c3 - s1 * s2 * s3,
    ]
}
/// `Quaternion.setFromRotationMatrix`: the upper 3×3 only.
pub fn from_rotation_matrix(te: &Matrix) -> Quat {
    let (m11, m12, m13) = (te[0], te[4], te[8]);
    let (m21, m22, m23) = (te[1], te[5], te[9]);
    let (m31, m32, m33) = (te[2], te[6], te[10]);
    let trace = m11 + m22 + m33;
    if trace > 0.0 {
        let s = 0.5 / (trace + 1.0).sqrt();
        [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]
    } else if m11 > m22 && m11 > m33 {
        let s = 2.0 * (1.0 + m11 - m22 - m33).sqrt();
        [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]
    } else if m22 > m33 {
        let s = 2.0 * (1.0 + m22 - m11 - m33).sqrt();
        [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]
    } else {
        let s = 2.0 * (1.0 + m33 - m11 - m22).sqrt();
        [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s]
    }
}

/// `Matrix4.compose(position, quaternion, scale)`.
pub fn compose(position: Vec3, q: Quat, scale: Vec3) -> Matrix {
    let [x, y, z, w] = q;
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    let [sx, sy, sz] = scale;
    [
        (1.0 - (yy + zz)) * sx,
        (xy + wz) * sx,
        (xz - wy) * sx,
        0.0,
        (xy - wz) * sy,
        (1.0 - (xx + zz)) * sy,
        (yz + wx) * sy,
        0.0,
        (xz + wy) * sz,
        (yz - wx) * sz,
        (1.0 - (xx + yy)) * sz,
        0.0,
        position[0],
        position[1],
        position[2],
        1.0,
    ]
}
/// `Matrix4.determinant`.
pub fn determinant(te: &Matrix) -> f64 {
    let (n11, n12, n13, n14) = (te[0], te[4], te[8], te[12]);
    let (n21, n22, n23, n24) = (te[1], te[5], te[9], te[13]);
    let (n31, n32, n33, n34) = (te[2], te[6], te[10], te[14]);
    let (n41, n42, n43, n44) = (te[3], te[7], te[11], te[15]);
    let t11 = n23 * n34 - n24 * n33;
    let t12 = n22 * n34 - n24 * n32;
    let t13 = n22 * n33 - n23 * n32;
    let t21 = n21 * n34 - n24 * n31;
    let t22 = n21 * n33 - n23 * n31;
    let t23 = n21 * n32 - n22 * n31;
    n11 * (n42 * t11 - n43 * t12 + n44 * t13) - n12 * (n41 * t11 - n43 * t21 + n44 * t22)
        + n13 * (n41 * t12 - n42 * t21 + n44 * t23)
        - n14 * (n41 * t13 - n42 * t22 + n43 * t23)
}
/// `Matrix4.decompose`: position, quaternion and scale (a singular matrix
/// decomposes to the identity rotation and unit scale).
pub fn decompose(te: &Matrix) -> (Vec3, Quat, Vec3) {
    let position = [te[12], te[13], te[14]];
    let det = determinant(te);
    if det == 0.0 {
        return (position, IDENTITY_QUATERNION, [1.0, 1.0, 1.0]);
    }
    let mut sx = length([te[0], te[1], te[2]]);
    let sy = length([te[4], te[5], te[6]]);
    let sz = length([te[8], te[9], te[10]]);
    if det < 0.0 {
        sx = -sx;
    }
    let mut m = *te;
    let (inv_x, inv_y, inv_z) = (1.0 / sx, 1.0 / sy, 1.0 / sz);
    m[0] *= inv_x;
    m[1] *= inv_x;
    m[2] *= inv_x;
    m[4] *= inv_y;
    m[5] *= inv_y;
    m[6] *= inv_y;
    m[8] *= inv_z;
    m[9] *= inv_z;
    m[10] *= inv_z;
    (position, from_rotation_matrix(&m), [sx, sy, sz])
}
/// The rotation `Matrix4.lookAt(eye, target, up)` writes (its other elements
/// are left as they were; nothing here reads them).
pub fn look_at(eye: Vec3, target: Vec3, up: Vec3) -> Matrix {
    let mut z = sub(eye, target);
    if dot(z, z) == 0.0 {
        z[2] = 1.0;
    }
    z = normalize(z);
    let mut x = cross(up, z);
    if dot(x, x) == 0.0 {
        if up[2].abs() == 1.0 {
            z[0] += 0.0001;
        } else {
            z[2] += 0.0001;
        }
        z = normalize(z);
        x = cross(up, z);
    }
    x = normalize(x);
    let y = cross(z, x);
    let mut te = IDENTITY;
    te[0] = x[0];
    te[4] = y[0];
    te[8] = z[0];
    te[1] = x[1];
    te[5] = y[1];
    te[9] = z[1];
    te[2] = x[2];
    te[6] = y[2];
    te[10] = z[2];
    te
}
/// `Matrix4.getMaxScaleOnAxis`.
pub fn max_scale_on_axis(te: &Matrix) -> f64 {
    let x = te[0] * te[0] + te[1] * te[1] + te[2] * te[2];
    let y = te[4] * te[4] + te[5] * te[5] + te[6] * te[6];
    let z = te[8] * te[8] + te[9] * te[9] + te[10] * te[10];
    js_math::max(js_math::max(x, y), z).sqrt()
}

/// A `PerspectiveCamera` (zoom 1, no view offset or film offset) at a
/// position, turned by `lookAt(target)` with its `up`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Camera {
    pub fov: f64,
    pub aspect: f64,
    pub near: f64,
    pub far: f64,
    pub position: Vec3,
    pub target: Vec3,
    pub up: Vec3,
}

/// What a camera's matrices are once updated.
#[derive(Debug, Clone, Copy)]
pub struct CameraMatrices {
    pub fov: f64,
    pub world: Matrix,
    pub projection_inverse: Matrix,
}

impl Camera {
    /// `updateProjectionMatrix`, `lookAt` and `updateMatrixWorld`.
    pub fn matrices(&self) -> CameraMatrices {
        const DEG2RAD: f64 = std::f64::consts::PI / 180.0;
        let near = self.near;
        // Zoom 1: three divides by it.
        let top = near * tan(DEG2RAD * 0.5 * self.fov);
        let height = 2.0 * top;
        let width = self.aspect * height;
        let left = -0.5 * width;
        let (right, bottom) = (left + width, top - height);
        let far = self.far;
        let x = 2.0 * near / (right - left);
        let y = 2.0 * near / (top - bottom);
        let a = (right + left) / (right - left);
        let b = (top + bottom) / (top - bottom);
        let c = -(far + near) / (far - near);
        let d = (-2.0 * far * near) / (far - near);
        let projection = [
            x, 0.0, 0.0, 0.0, 0.0, y, 0.0, 0.0, a, b, c, -1.0, 0.0, 0.0, d, 0.0,
        ];
        // `Object3D.lookAt` on a camera: the eye is the position the world
        // matrix carries, which `compose` writes unchanged.
        let quaternion = from_rotation_matrix(&look_at(self.position, self.target, self.up));
        CameraMatrices {
            fov: self.fov,
            world: compose(self.position, quaternion, [1.0, 1.0, 1.0]),
            projection_inverse: invert(&projection),
        }
    }
}

/// A `Ray`: an origin and a unit direction.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ray {
    pub origin: Vec3,
    pub direction: Vec3,
}

impl Ray {
    /// `Raycaster.setFromCamera` for a perspective camera and an NDC pointer.
    pub fn from_camera(x: f64, y: f64, camera: &CameraMatrices) -> Self {
        let origin = [camera.world[12], camera.world[13], camera.world[14]];
        let unprojected = apply(
            &apply(&[x, y, 0.5], &camera.projection_inverse),
            &camera.world,
        );
        Self {
            origin,
            direction: normalize(sub(unprojected, origin)),
        }
    }
    /// `Ray.at(t)`: `origin.addScaledVector(direction, t)`.
    pub fn at(&self, t: f64) -> Vec3 {
        [
            self.origin[0] + self.direction[0] * t,
            self.origin[1] + self.direction[1] * t,
            self.origin[2] + self.direction[2] * t,
        ]
    }
    /// `Ray.applyMatrix4`.
    pub fn transformed(&self, m: &Matrix) -> Self {
        Self {
            origin: apply(&self.origin, m),
            direction: transform_direction(self.direction, m),
        }
    }
    /// Whether `Ray.intersectSphere` finds a point.
    pub fn meets_sphere(&self, center: Vec3, radius: f64) -> bool {
        let v = sub(center, self.origin);
        let tca = dot(v, self.direction);
        let d2 = dot(v, v) - tca * tca;
        let radius2 = radius * radius;
        if d2 > radius2 {
            return false;
        }
        let thc = (radius2 - d2).sqrt();
        let t1 = tca + thc;
        // `t1 < 0` is the only miss left; a NaN `t1` meets, as in three.
        t1 >= 0.0 || t1.is_nan()
    }
    /// `Ray.intersectTriangle(a, b, c, backfaceCulling)`: the distance along the ray.
    pub fn intersect_triangle(&self, a: Vec3, b: Vec3, c: Vec3, cull: bool) -> Option<f64> {
        let edge1 = sub(b, a);
        let edge2 = sub(c, a);
        let normal = cross(edge1, edge2);
        let mut ddn = dot(self.direction, normal);
        let sign;
        if ddn > 0.0 {
            if cull {
                return None;
            }
            sign = 1.0;
        } else if ddn < 0.0 {
            sign = -1.0;
            ddn = -ddn;
        } else {
            return None;
        }
        let diff = sub(self.origin, a);
        let ddqxe2 = sign * dot(self.direction, cross(diff, edge2));
        if ddqxe2 < 0.0 {
            return None;
        }
        let dde1xq = sign * dot(self.direction, cross(edge1, diff));
        if dde1xq < 0.0 {
            return None;
        }
        if ddqxe2 + dde1xq > ddn {
            return None;
        }
        let qdn = -sign * dot(diff, normal);
        if qdn < 0.0 {
            return None;
        }
        Some(qdn / ddn)
    }
}
