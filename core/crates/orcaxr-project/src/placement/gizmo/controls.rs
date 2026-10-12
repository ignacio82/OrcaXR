//! `TransformControls`' behaviour (three r184), as the workspace drives it:
//! one render (`scene.updateMatrixWorld(true)`: the proxy under its root, then
//! `TransformControlsRoot`, `TransformControlsGizmo` and
//! `TransformControlsPlane`) before every pointer call, then `pointerHover`,
//! `pointerDown`, `pointerMove` or `pointerUp`.
use super::geometry::{Groups, Handle, Shape, YELLOW, groups};
use super::math::{
    CameraMatrices, IDENTITY, IDENTITY_QUATERNION, Matrix, Quat, Ray, UNIT_X, UNIT_Y, UNIT_Z, Vec3,
    ZERO, add, angle_to, apply, apply_quaternion, compose, conjugate, cross, decompose, distance,
    distance_squared, divide_components, dot, from_axis_angle, from_euler, from_rotation_matrix,
    invert, length, look_at, max_scale_on_axis, multiply, multiply_components, normalize,
    quat_multiply, quat_normalize, scale, sub,
};
use super::{Event, EventKind, Mode, Scene, Space, State};
use crate::js_math::{self, atan2, tan};
use std::f64::consts::PI;

/// Where a handle is drawn, whether it shows, and its material after highlighting.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placed {
    pub matrix: Matrix,
    pub visible: bool,
    pub color: Vec3,
    pub opacity: f64,
}

/// One render's results.
#[derive(Debug, Clone)]
pub struct Frame {
    pub camera: CameraMatrices,
    pub camera_position: Vec3,
    pub camera_quaternion: Quat,
    pub proxy_world: Matrix,
    pub world_position: Vec3,
    pub world_quaternion: Quat,
    pub world_quaternion_inv: Quat,
    pub parent_quaternion_inv: Quat,
    pub parent_scale: Vec3,
    pub eye: Vec3,
    pub pickers: Vec<Placed>,
    pub gizmo: Vec<Placed>,
    pub helper: Vec<Placed>,
    pub plane: Matrix,
}

fn mode_index(mode: Mode) -> usize {
    match mode {
        Mode::Translate => 0,
        Mode::Rotate => 1,
        Mode::Scale => 2,
    }
}

/// `String.prototype.search` of a handle name in an axis (both plain letters).
fn contains(axis: &str, name: &str) -> bool {
    axis.contains(name)
}

/// `TransformControlsGizmo.updateMatrixWorld` for one handle.
fn place(handle: &Handle, scene: &Scene, state: &State, frame: &Frame) -> Placed {
    let space = if scene.mode == Mode::Scale {
        Space::Local
    } else {
        scene.space
    };
    let quaternion = if space == Space::Local {
        frame.world_quaternion
    } else {
        IDENTITY_QUATERNION
    };
    let name = handle.name;
    let axis = state.axis;
    let mut visible = true;
    // `rotation.set(0, 0, 0)` sets the quaternion from that Euler.
    let mut q = from_euler(ZERO);
    let mut position = frame.world_position;
    let fov = frame.camera.fov;
    // Zoom and size are 1: dividing or multiplying by them changes nothing.
    let factor = distance(frame.world_position, frame.camera_position)
        * js_math::min(1.9 * tan(PI * fov / 360.0), 7.0);
    let mut s = scale([1.0, 1.0, 1.0], factor / 4.0);
    let aligned = |unit: Vec3, q: Quat| dot(apply_quaternion(unit, q), frame.eye).abs();

    if handle.helper {
        visible = false;
        match name {
            "AXIS" => {
                visible = axis.is_some();
                match axis {
                    Some("X") => {
                        q = quat_multiply(quaternion, from_euler([0.0, 0.0, 0.0]));
                        if aligned(UNIT_X, quaternion) > 0.9 {
                            visible = false;
                        }
                    }
                    Some("Y") => {
                        q = quat_multiply(quaternion, from_euler([0.0, 0.0, PI / 2.0]));
                        if aligned(UNIT_Y, quaternion) > 0.9 {
                            visible = false;
                        }
                    }
                    Some("Z") => {
                        q = quat_multiply(quaternion, from_euler([0.0, PI / 2.0, 0.0]));
                        if aligned(UNIT_Z, quaternion) > 0.9 {
                            visible = false;
                        }
                    }
                    Some("XYZE") => {
                        let turn = from_euler([0.0, PI / 2.0, 0.0]);
                        q = from_rotation_matrix(&look_at(ZERO, state.rotation_axis, UNIT_Y));
                        q = quat_multiply(q, turn);
                        visible = state.dragging;
                    }
                    Some("E") => visible = false,
                    _ => {}
                }
            }
            "START" => {
                position = state.start.world_position;
                visible = state.dragging;
            }
            "END" => {
                position = frame.world_position;
                visible = state.dragging;
            }
            "DELTA" => {
                position = state.start.world_position;
                q = state.start.world_quaternion;
                let delta = scale(
                    sub(
                        add([1e-10, 1e-10, 1e-10], state.start.world_position),
                        frame.world_position,
                    ),
                    -1.0,
                );
                s = apply_quaternion(delta, conjugate(state.start.world_quaternion));
                visible = state.dragging;
            }
            _ => {
                q = quaternion;
                position = if state.dragging {
                    state.start.world_position
                } else {
                    frame.world_position
                };
                if let Some(axis) = axis {
                    visible = contains(axis, name);
                }
            }
        }
        return Placed {
            matrix: multiply(&IDENTITY, &compose(position, q, s)),
            visible,
            color: handle.material.color,
            opacity: handle.material.opacity,
        };
    }

    q = quaternion;
    match scene.mode {
        Mode::Translate | Mode::Scale => {
            const AXIS_HIDE_THRESHOLD: f64 = 0.99;
            const PLANE_HIDE_THRESHOLD: f64 = 0.2;
            let hidden = match name {
                "X" => aligned(UNIT_X, quaternion) > AXIS_HIDE_THRESHOLD,
                "Y" => aligned(UNIT_Y, quaternion) > AXIS_HIDE_THRESHOLD,
                "Z" => aligned(UNIT_Z, quaternion) > AXIS_HIDE_THRESHOLD,
                "XY" => aligned(UNIT_Z, quaternion) < PLANE_HIDE_THRESHOLD,
                "YZ" => aligned(UNIT_X, quaternion) < PLANE_HIDE_THRESHOLD,
                "XZ" => aligned(UNIT_Y, quaternion) < PLANE_HIDE_THRESHOLD,
                _ => false,
            };
            if hidden {
                s = [1e-10, 1e-10, 1e-10];
                visible = false;
            }
        }
        Mode::Rotate => {
            let start = quaternion;
            let align = apply_quaternion(frame.eye, conjugate(quaternion));
            if name.contains('E') {
                q = from_rotation_matrix(&look_at(frame.eye, ZERO, UNIT_Y));
            }
            let turn = match name {
                "X" => Some(from_axis_angle(UNIT_X, atan2(-align[1], align[2]))),
                "Y" => Some(from_axis_angle(UNIT_Y, atan2(align[0], align[2]))),
                "Z" => Some(from_axis_angle(UNIT_Z, atan2(align[1], align[0]))),
                _ => None,
            };
            if let Some(turn) = turn {
                q = quat_multiply(start, turn);
            }
        }
    }
    // Every axis is shown (`showX` … `showXZ`); the axis under the pointer is highlighted.
    let highlighted =
        axis.is_some_and(|axis| name == axis || (name.len() == 1 && axis.contains(name)));
    let (color, opacity) = if highlighted {
        (YELLOW, 1.0)
    } else {
        (handle.material.color, handle.material.opacity)
    };
    Placed {
        matrix: multiply(&IDENTITY, &compose(position, q, s)),
        visible,
        color,
        opacity,
    }
}

/// `TransformControlsPlane.updateMatrixWorld`: the plane a drag moves on.
fn plane(scene: &Scene, state: &State, frame: &Frame) -> Matrix {
    let space = if scene.mode == Mode::Scale {
        Space::Local
    } else {
        scene.space
    };
    let q = if space == Space::Local {
        frame.world_quaternion
    } else {
        IDENTITY_QUATERNION
    };
    let (v1, v2, v3) = (
        apply_quaternion(UNIT_X, q),
        apply_quaternion(UNIT_Y, q),
        apply_quaternion(UNIT_Z, q),
    );
    let eye = frame.eye;
    let mut align = v2;
    // An axis the mode has no plane for keeps three's previous direction;
    // only a mode change during a drag reaches it, and the port faces the
    // camera there.
    let mut direction = ZERO;
    if scene.mode != Mode::Rotate {
        match state.axis {
            Some("X") => {
                align = cross(eye, v1);
                direction = cross(v1, align);
            }
            Some("Y") => {
                align = cross(eye, v2);
                direction = cross(v2, align);
            }
            Some("Z") => {
                align = cross(eye, v3);
                direction = cross(v3, align);
            }
            Some("XY") => direction = v3,
            Some("YZ") => direction = v1,
            Some("XZ") => {
                align = v3;
                direction = v2;
            }
            _ => {}
        }
    }
    let quaternion = if length(direction) == 0.0 {
        frame.camera_quaternion
    } else {
        from_rotation_matrix(&look_at(ZERO, direction, align))
    };
    multiply(
        &IDENTITY,
        &compose(frame.world_position, quaternion, [1.0, 1.0, 1.0]),
    )
}

/// One render of the scene with the controls' state.
pub fn render(scene: &Scene, state: &State) -> Frame {
    let root_world = multiply(
        &IDENTITY,
        &compose(scene.root.position, scene.root.quaternion, scene.root.scale),
    );
    let proxy = &state.proxy;
    let proxy_world = multiply(
        &root_world,
        &compose(proxy.position, proxy.quaternion, proxy.scale),
    );
    let (_, parent_quaternion, parent_scale) = decompose(&root_world);
    let (world_position, world_quaternion, _) = decompose(&proxy_world);
    let camera = scene.camera.matrices();
    let (camera_position, camera_quaternion, _) = decompose(&camera.world);
    let mut frame = Frame {
        camera,
        camera_position,
        camera_quaternion,
        proxy_world,
        world_position,
        world_quaternion,
        world_quaternion_inv: conjugate(world_quaternion),
        parent_quaternion_inv: conjugate(parent_quaternion),
        parent_scale,
        eye: normalize(sub(camera_position, world_position)),
        pickers: Vec::new(),
        gizmo: Vec::new(),
        helper: Vec::new(),
        plane: IDENTITY,
    };
    let all: &Groups = groups();
    let mode = mode_index(scene.mode);
    let placed = |handles: &[Handle], frame: &Frame| -> Vec<Placed> {
        handles
            .iter()
            .map(|h| place(h, scene, state, frame))
            .collect()
    };
    frame.pickers = placed(&all.picker[mode], &frame);
    frame.gizmo = placed(&all.gizmo[mode], &frame);
    frame.helper = placed(&all.helper[mode], &frame);
    frame.plane = plane(scene, state, &frame);
    frame
}

/// `Mesh.raycast` over a sequence of meshes, then `intersectObjectWithRay`:
/// the nearest hit (the earlier mesh and triangle on a tie) among the meshes
/// that count, as its mesh's position and world point.
fn first_hit<'a>(
    meshes: impl Iterator<Item = (&'a Shape, &'a Matrix, bool)>,
    ray: &Ray,
    cull: bool,
) -> Option<(usize, Vec3)> {
    let mut best: Option<(f64, usize, Vec3)> = None;
    for (position, (shape, world, counts)) in meshes.enumerate() {
        // Three intersects every mesh and keeps the first visible hit after a
        // stable sort by distance: the nearest counting hit, earliest on a tie.
        if !counts {
            continue;
        }
        let center = apply(&shape.center, world);
        let radius = shape.radius * max_scale_on_axis(world);
        let recast = Ray {
            origin: ray.at(0.0),
            direction: ray.direction,
        };
        let contains_origin = distance_squared(recast.origin, center) <= radius * radius;
        if !contains_origin && !recast.meets_sphere(center, radius) {
            continue;
        }
        let local = ray.transformed(&invert(world));
        for triangle in 0..shape.triangles() {
            let [a, b, c] = shape.triangle(triangle);
            let Some(t) = local.intersect_triangle(a, b, c, cull) else {
                continue;
            };
            let point = apply(&local.at(t), world);
            let distance = distance(ray.origin, point);
            // Raycaster near 0, far ∞; a NaN distance (a non-finite scene) is never nearest.
            if distance < 0.0 || distance.is_nan() {
                continue;
            }
            if best.is_none_or(|(nearest, _, _)| distance < nearest) {
                best = Some((distance, position, point));
            }
        }
    }
    best.map(|(_, position, point)| (position, point))
}

/// The picker handle under the pointer (`pointerHover`).
fn pick(scene: &Scene, frame: &Frame, ray: &Ray) -> Option<&'static str> {
    let handles = &groups().picker[mode_index(scene.mode)];
    let meshes = handles
        .iter()
        .zip(&frame.pickers)
        .map(|(handle, placed)| (&handle.shape, &placed.matrix, placed.visible));
    first_hit(meshes, ray, true).map(|(index, _)| handles[index].name)
}

/// Where the ray meets the drag plane (both sides, visible or not).
fn on_plane(frame: &Frame, ray: &Ray) -> Option<Vec3> {
    let plane = &groups().plane;
    first_hit(std::iter::once((plane, &frame.plane, true)), ray, false).map(|(_, point)| point)
}

fn unit(axis: &str) -> Vec3 {
    match axis {
        "X" => UNIT_X,
        "Y" => UNIT_Y,
        _ => UNIT_Z,
    }
}

/// `pointerMove`: whether it moved the proxy (three's `objectChange`).
fn drag(scene: &Scene, state: &mut State, frame: &Frame, ray: &Ray) -> bool {
    let Some(axis) = state.axis else {
        return false;
    };
    if !state.dragging {
        return false;
    }
    let space = if scene.mode == Mode::Scale {
        Space::Local
    } else if matches!(axis, "E" | "XYZE" | "XYZ") {
        Space::World
    } else {
        scene.space
    };
    let Some(point) = on_plane(frame, ray) else {
        return false;
    };
    let start = state.start;
    let point_end = sub(point, start.world_position);
    match scene.mode {
        Mode::Translate => {
            let local = space == Space::Local && axis != "XYZ";
            let mut offset = sub(point_end, start.point);
            if local {
                offset = apply_quaternion(offset, frame.world_quaternion_inv);
            }
            for (k, letter) in ['X', 'Y', 'Z'].into_iter().enumerate() {
                if !axis.contains(letter) {
                    offset[k] = 0.0;
                }
            }
            offset = if local {
                divide_components(
                    apply_quaternion(offset, start.quaternion),
                    frame.parent_scale,
                )
            } else {
                divide_components(
                    apply_quaternion(offset, frame.parent_quaternion_inv),
                    frame.parent_scale,
                )
            };
            // No translation snap; the bounds are ±∞.
            state.proxy.position = add(offset, start.position)
                .map(|v| js_math::max(f64::NEG_INFINITY, js_math::min(f64::INFINITY, v)));
        }
        Mode::Scale => {
            let factor = if axis.contains("XYZ") {
                let mut d = length(point_end) / length(start.point);
                if dot(point_end, start.point) < 0.0 {
                    d *= -1.0;
                }
                [d, d, d]
            } else {
                let from = apply_quaternion(start.point, frame.world_quaternion_inv);
                let mut to = apply_quaternion(point_end, frame.world_quaternion_inv);
                to = divide_components(to, from);
                for (k, letter) in ['X', 'Y', 'Z'].into_iter().enumerate() {
                    if !axis.contains(letter) {
                        to[k] = 1.0;
                    }
                }
                to
            };
            // No scale snap.
            state.proxy.scale = multiply_components(start.scale, factor);
        }
        Mode::Rotate => {
            let offset = sub(point_end, start.point);
            let speed = 20.0 / distance(frame.world_position, frame.camera_position);
            let eye = frame.eye;
            let mut in_plane = false;
            let mut angle = 0.0;
            match axis {
                "XYZE" => {
                    state.rotation_axis = normalize(cross(offset, eye));
                    angle = dot(offset, cross(state.rotation_axis, eye)) * speed;
                }
                "X" | "Y" | "Z" => {
                    state.rotation_axis = unit(axis);
                    let mut toward = unit(axis);
                    if space == Space::Local {
                        toward = apply_quaternion(toward, frame.world_quaternion);
                    }
                    toward = cross(toward, eye);
                    if length(toward) == 0.0 {
                        in_plane = true;
                    } else {
                        angle = dot(offset, normalize(toward)) * speed;
                    }
                }
                _ => {}
            }
            if axis == "E" || in_plane {
                state.rotation_axis = eye;
                angle = angle_to(point_end, start.point);
                let start_norm = normalize(start.point);
                let end_norm = normalize(point_end);
                angle *= if dot(cross(end_norm, start_norm), eye) < 0.0 {
                    1.0
                } else {
                    -1.0
                };
            }
            // No rotation snap.
            state.proxy.quaternion = if space == Space::Local && axis != "E" && axis != "XYZE" {
                quat_normalize(quat_multiply(
                    start.quaternion,
                    from_axis_angle(state.rotation_axis, angle),
                ))
            } else {
                state.rotation_axis =
                    apply_quaternion(state.rotation_axis, frame.parent_quaternion_inv);
                quat_normalize(quat_multiply(
                    from_axis_angle(state.rotation_axis, angle),
                    start.quaternion,
                ))
            };
        }
    }
    true
}

/// One pointer event, a render before each pointer call; whether the proxy changed.
pub fn step(scene: &Scene, state: &mut State, event: Event) -> bool {
    let frame = render(scene, state);
    let ray = Ray::from_camera(event.x, event.y, &frame.camera);
    match event.kind {
        EventKind::Hover => {
            if !state.dragging {
                state.axis = pick(scene, &frame, &ray);
            }
            false
        }
        EventKind::Press => {
            if state.dragging {
                return false;
            }
            state.axis = pick(scene, &frame, &ray);
            if state.axis.is_none() {
                return false;
            }
            let frame = render(scene, state);
            // Deliberate: a press whose ray misses the plane starts no drag.
            let Some(point) = on_plane(&frame, &ray) else {
                return false;
            };
            let (world_position, world_quaternion, _) = decompose(&frame.proxy_world);
            state.start = super::Start {
                position: state.proxy.position,
                quaternion: state.proxy.quaternion,
                scale: state.proxy.scale,
                world_position,
                world_quaternion,
                point: sub(point, world_position),
            };
            state.dragging = true;
            false
        }
        EventKind::Move => drag(scene, state, &frame, &ray),
        EventKind::Release => {
            state.dragging = false;
            state.axis = None;
            false
        }
    }
}
