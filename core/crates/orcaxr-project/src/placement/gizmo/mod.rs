//! The workspace's transform gizmo (`TransformGizmoExchange.ts`): three.js
//! r184's `TransformControls` as `OrcaWorkspace.setup2DControls` configures it
//! (size 1, world space by default, no snaps, every axis shown), ported
//! operation for operation — the handle geometry its generators bake
//! ([`geometry`]), the camera, ray and matrix arithmetic ([`math`], V8's
//! trigonometry from [`crate::js_math`]), the per-render handle placement,
//! screen-constant size, view-angle hiding, rotate-ring alignment and
//! highlighting, hover picking (three's `Mesh.raycast`: bounding sphere,
//! local ray, front faces for the pickers and both sides for the drag plane,
//! the nearest visible hit) and the translate, rotate and scale drags in world
//! and local space ([`controls`]).
//!
//! The scene is the browser's: a root (printer millimetres to world units:
//! the browser's surface root is rotated −90° about X and scaled to 0.00175
//! units a millimetre; a host rendering in metres uses 0.001) holding the
//! proxy, and the helper beside it; a perspective camera at a position looking
//! at a target. Each pointer event is preceded by a render, so the drag plane
//! is current at a press (a mouse's hover keeps it current in the browser; a
//! touch press there would use the previous frame's plane); a press whose ray
//! misses the plane starts no drag (three would start one from stale values).
//!
//! The API is stateless canonical JSON. The state — `{"axis","changed",
//! "dragging","proxy","rotationAxis","start"}` — carries what three keeps
//! between events, every number exactly (`-0`, `NaN` and the infinities as
//! strings); hosts keep it opaque:
//! - [`attach_json`]: `{"proxy"}` → a fresh state, the controls attached to a
//!   proxy pose `{"position","quaternion","scale"}`;
//! - [`step_json`]: `{"camera","event","mode","root","space","state"}` → the
//!   state after one event `{"kind","x","y"}` (`hover`, `press`, `move` or
//!   `release`, the pointer in normalized device coordinates), `changed`
//!   saying whether it moved the proxy;
//! - [`present_json`]: `{"camera","mode","root","space","state"}` → the view
//!   `{"axis","dragging","handles","proxy"}`, every handle of the mode's gizmo
//!   then helper group as `{"color","group","matrix","name","opacity","tag",
//!   "visible"}` (world matrix column-major, colour in three's linear working
//!   space);
//! - [`geometry_json`]: every group's baked handle geometry and the plane's,
//!   handle order matching the view's;
//! - [`changes_json`]: `{"initialProxy","mode","origins","proxy"}` → the
//!   instance transforms a drag submits (`gizmoDragChanges`), or
//!   `{"error":"invalid_drag","message"}`.
//!
//! A camera is `{"aspect","far","fov","near","position","target","up"}`
//! (0° < fov < 180°, aspect > 0, 0 < near < far). A malformed request is
//! refused as `invalid_request`.
pub mod controls;
pub mod geometry;
pub mod math;

use super::fields::{self, Origin, Tool};
use geometry::{Kind, Shape};
use math::{Camera, Quat, Vec3};
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;
use std::sync::OnceLock;

pub use super::bed::{INPUT_LIMIT, INVALID_REQUEST, OUTPUT_LIMIT};
/// The code of a drag whose changes the workspace cannot project.
pub const INVALID_DRAG: &str = "invalid_drag";

/// `TransformControls.mode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Translate,
    Rotate,
    Scale,
}
/// `TransformControls.space`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Space {
    World,
    Local,
}
/// An object's local position, quaternion and scale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pose {
    pub position: Vec3,
    pub quaternion: Quat,
    pub scale: Vec3,
}
/// What a drag captured at its press.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Start {
    pub position: Vec3,
    pub quaternion: Quat,
    pub scale: Vec3,
    pub world_position: Vec3,
    pub world_quaternion: Quat,
    /// Where the press met the plane, from the proxy's world position.
    pub point: Vec3,
}
/// What the controls keep between events.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct State {
    pub axis: Option<&'static str>,
    /// Whether the last event moved the proxy (`objectChange`).
    pub changed: bool,
    pub dragging: bool,
    pub proxy: Pose,
    pub rotation_axis: Vec3,
    pub start: Start,
}
impl State {
    /// `attach(proxy)` on new controls.
    pub fn attach(proxy: Pose) -> Self {
        Self {
            axis: None,
            changed: false,
            dragging: false,
            proxy,
            rotation_axis: math::ZERO,
            start: Start {
                position: math::ZERO,
                quaternion: math::IDENTITY_QUATERNION,
                scale: math::ZERO,
                world_position: math::ZERO,
                world_quaternion: math::IDENTITY_QUATERNION,
                point: math::ZERO,
            },
        }
    }
}
/// The camera, the root holding the proxy, the mode and the space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scene {
    pub camera: Camera,
    pub root: Pose,
    pub mode: Mode,
    pub space: Space,
}
/// A pointer event's kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventKind {
    Hover,
    Press,
    Move,
    Release,
}
/// One pointer event in normalized device coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Event {
    pub kind: EventKind,
    pub x: f64,
    pub y: f64,
}

/// The axes a handle can stand for.
const AXES: [&str; 9] = ["X", "Y", "Z", "XY", "YZ", "XZ", "XYZ", "XYZE", "E"];

/// One event applied to a state.
pub fn step(scene: &Scene, state: &State, event: Event) -> State {
    let mut next = *state;
    next.changed = controls::step(scene, &mut next, event);
    next
}

// --- JSON ----------------------------------------------------------------------------------

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn string(text: &str) -> Value {
    Value::String(units(text))
}
fn number(value: f64) -> Value {
    if value.is_finite() {
        Value::Number(value)
    } else {
        Value::Null
    }
}
fn numbers(values: &[f64]) -> Value {
    Value::Array(values.iter().copied().map(number).collect())
}
/// A state number, exactly: `-0`, `NaN` and the infinities as strings.
fn exact(value: f64) -> Value {
    if value.is_nan() {
        string("NaN")
    } else if value == f64::INFINITY {
        string("Infinity")
    } else if value == f64::NEG_INFINITY {
        string("-Infinity")
    } else if value == 0.0 && value.is_sign_negative() {
        string("-0")
    } else {
        Value::Number(value)
    }
}
fn exacts(values: &[f64]) -> Value {
    Value::Array(values.iter().copied().map(exact).collect())
}
fn object(members: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(members.into_iter().map(|(k, v)| (units(k), v)).collect())
}
fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| OUTPUT_LIMIT)
}
fn read(request: &str) -> Result<Value, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(request).map_err(|_| INVALID_REQUEST)
}
type Members = BTreeMap<Vec<u16>, Value>;
fn members(value: Value, keys: &[&str]) -> Result<Members, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    if fields.len() != keys.len() || !keys.iter().all(|k| fields.contains_key(&units(k))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn take(fields: &mut Members, key: &str) -> Value {
    fields.remove(&units(key)).unwrap_or(Value::Null)
}
fn finite(value: Value) -> Result<f64, &'static str> {
    match value {
        Value::Number(n) if n.is_finite() => Ok(n),
        _ => Err(INVALID_REQUEST),
    }
}
fn list<const N: usize>(
    value: Value,
    read: impl Fn(Value) -> Result<f64, &'static str>,
) -> Result<[f64; N], &'static str> {
    let Value::Array(items) = value else {
        return Err(INVALID_REQUEST);
    };
    let items: [Value; N] = items.try_into().map_err(|_| INVALID_REQUEST)?;
    let mut out = [0.0; N];
    for (slot, item) in out.iter_mut().zip(items) {
        *slot = read(item)?;
    }
    Ok(out)
}
fn read_exact(value: Value) -> Result<f64, &'static str> {
    match value {
        Value::Number(n) => Ok(n),
        Value::String(text) => match String::from_utf16(&text).as_deref() {
            Ok("NaN") => Ok(f64::NAN),
            Ok("Infinity") => Ok(f64::INFINITY),
            Ok("-Infinity") => Ok(f64::NEG_INFINITY),
            Ok("-0") => Ok(-0.0),
            _ => Err(INVALID_REQUEST),
        },
        _ => Err(INVALID_REQUEST),
    }
}
fn text(value: Value) -> Result<String, &'static str> {
    match value {
        Value::String(units) => String::from_utf16(&units).map_err(|_| INVALID_REQUEST),
        _ => Err(INVALID_REQUEST),
    }
}
fn boolean(value: Value) -> Result<bool, &'static str> {
    match value {
        Value::Bool(b) => Ok(b),
        _ => Err(INVALID_REQUEST),
    }
}
fn pose_with(
    value: Value,
    read: impl Fn(Value) -> Result<f64, &'static str> + Copy,
) -> Result<Pose, &'static str> {
    let mut fields = members(value, &["position", "quaternion", "scale"])?;
    Ok(Pose {
        position: list(take(&mut fields, "position"), read)?,
        quaternion: list(take(&mut fields, "quaternion"), read)?,
        scale: list(take(&mut fields, "scale"), read)?,
    })
}
fn pose(value: Value) -> Result<Pose, &'static str> {
    pose_with(value, finite)
}
fn camera(value: Value) -> Result<Camera, &'static str> {
    let mut fields = members(
        value,
        &["aspect", "far", "fov", "near", "position", "target", "up"],
    )?;
    let camera = Camera {
        aspect: finite(take(&mut fields, "aspect"))?,
        far: finite(take(&mut fields, "far"))?,
        fov: finite(take(&mut fields, "fov"))?,
        near: finite(take(&mut fields, "near"))?,
        position: list(take(&mut fields, "position"), finite)?,
        target: list(take(&mut fields, "target"), finite)?,
        up: list(take(&mut fields, "up"), finite)?,
    };
    let valid = camera.fov > 0.0
        && camera.fov < 180.0
        && camera.aspect > 0.0
        && camera.near > 0.0
        && camera.far > camera.near;
    if valid {
        Ok(camera)
    } else {
        Err(INVALID_REQUEST)
    }
}
fn mode(value: Value) -> Result<Mode, &'static str> {
    match text(value)?.as_str() {
        "translate" => Ok(Mode::Translate),
        "rotate" => Ok(Mode::Rotate),
        "scale" => Ok(Mode::Scale),
        _ => Err(INVALID_REQUEST),
    }
}
fn space(value: Value) -> Result<Space, &'static str> {
    match text(value)?.as_str() {
        "world" => Ok(Space::World),
        "local" => Ok(Space::Local),
        _ => Err(INVALID_REQUEST),
    }
}
fn axis(value: Value) -> Result<Option<&'static str>, &'static str> {
    match value {
        Value::Null => Ok(None),
        value => {
            let name = text(value)?;
            AXES.iter()
                .find(|axis| **axis == name)
                .map(|axis| Some(*axis))
                .ok_or(INVALID_REQUEST)
        }
    }
}
fn state(value: Value) -> Result<State, &'static str> {
    let mut fields = members(
        value,
        &[
            "axis",
            "changed",
            "dragging",
            "proxy",
            "rotationAxis",
            "start",
        ],
    )?;
    let mut start = members(
        take(&mut fields, "start"),
        &[
            "point",
            "position",
            "quaternion",
            "scale",
            "worldPosition",
            "worldQuaternion",
        ],
    )?;
    Ok(State {
        axis: axis(take(&mut fields, "axis"))?,
        changed: boolean(take(&mut fields, "changed"))?,
        dragging: boolean(take(&mut fields, "dragging"))?,
        proxy: pose_with(take(&mut fields, "proxy"), read_exact)?,
        rotation_axis: list(take(&mut fields, "rotationAxis"), read_exact)?,
        start: Start {
            position: list(take(&mut start, "position"), read_exact)?,
            quaternion: list(take(&mut start, "quaternion"), read_exact)?,
            scale: list(take(&mut start, "scale"), read_exact)?,
            world_position: list(take(&mut start, "worldPosition"), read_exact)?,
            world_quaternion: list(take(&mut start, "worldQuaternion"), read_exact)?,
            point: list(take(&mut start, "point"), read_exact)?,
        },
    })
}
fn state_value(state: &State) -> Value {
    let pose = &state.proxy;
    let start = &state.start;
    object([
        ("axis", state.axis.map_or(Value::Null, string)),
        ("changed", Value::Bool(state.changed)),
        ("dragging", Value::Bool(state.dragging)),
        (
            "proxy",
            object([
                ("position", exacts(&pose.position)),
                ("quaternion", exacts(&pose.quaternion)),
                ("scale", exacts(&pose.scale)),
            ]),
        ),
        ("rotationAxis", exacts(&state.rotation_axis)),
        (
            "start",
            object([
                ("point", exacts(&start.point)),
                ("position", exacts(&start.position)),
                ("quaternion", exacts(&start.quaternion)),
                ("scale", exacts(&start.scale)),
                ("worldPosition", exacts(&start.world_position)),
                ("worldQuaternion", exacts(&start.world_quaternion)),
            ]),
        ),
    ])
}
fn scene(fields: &mut Members) -> Result<Scene, &'static str> {
    Ok(Scene {
        camera: camera(take(fields, "camera"))?,
        root: pose(take(fields, "root"))?,
        mode: mode(take(fields, "mode"))?,
        space: space(take(fields, "space"))?,
    })
}
fn event(value: Value) -> Result<Event, &'static str> {
    let mut fields = members(value, &["kind", "x", "y"])?;
    let kind = match text(take(&mut fields, "kind"))?.as_str() {
        "hover" => EventKind::Hover,
        "press" => EventKind::Press,
        "move" => EventKind::Move,
        "release" => EventKind::Release,
        _ => return Err(INVALID_REQUEST),
    };
    Ok(Event {
        kind,
        x: finite(take(&mut fields, "x"))?,
        y: finite(take(&mut fields, "y"))?,
    })
}

/// `{"proxy"}` → a fresh state attached to the proxy pose.
pub fn attach_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["proxy"])?;
    canonical(&state_value(&State::attach(pose(take(
        &mut fields,
        "proxy",
    ))?)))
}

/// `{"camera","event","mode","root","space","state"}` → the state after the event.
pub fn step_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(
        read(request)?,
        &["camera", "event", "mode", "root", "space", "state"],
    )?;
    let scene = scene(&mut fields)?;
    let event = event(take(&mut fields, "event"))?;
    let state = state(take(&mut fields, "state"))?;
    canonical(&state_value(&step(&scene, &state, event)))
}

/// The view a state shows: the axis, the drag, the proxy and every handle.
pub fn present(scene: &Scene, state: &State) -> Value {
    let frame = controls::render(scene, state);
    let all = geometry::groups();
    let mode = match scene.mode {
        Mode::Translate => 0,
        Mode::Rotate => 1,
        Mode::Scale => 2,
    };
    let handle = |group: &'static str| {
        move |(handle, placed): (&geometry::Handle, &controls::Placed)| {
            object([
                ("color", numbers(&placed.color)),
                ("group", string(group)),
                ("matrix", numbers(&placed.matrix)),
                ("name", string(handle.name)),
                ("opacity", number(placed.opacity)),
                (
                    "tag",
                    if handle.helper {
                        string("helper")
                    } else {
                        Value::Null
                    },
                ),
                ("visible", Value::Bool(placed.visible)),
            ])
        }
    };
    let handles = all.gizmo[mode]
        .iter()
        .zip(&frame.gizmo)
        .map(handle("gizmo"))
        .chain(
            all.helper[mode]
                .iter()
                .zip(&frame.helper)
                .map(handle("helper")),
        )
        .collect();
    let pose = &state.proxy;
    object([
        ("axis", state.axis.map_or(Value::Null, string)),
        ("dragging", Value::Bool(state.dragging)),
        ("handles", Value::Array(handles)),
        (
            "proxy",
            object([
                ("position", numbers(&pose.position)),
                ("quaternion", numbers(&pose.quaternion)),
                ("scale", numbers(&pose.scale)),
            ]),
        ),
    ])
}

/// `{"camera","mode","root","space","state"}` → the view.
pub fn present_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(
        read(request)?,
        &["camera", "mode", "root", "space", "state"],
    )?;
    let scene = scene(&mut fields)?;
    let state = state(take(&mut fields, "state"))?;
    canonical(&present(&scene, &state))
}

fn shape_value(name: &str, helper: bool, shape: &Shape) -> Value {
    object([
        (
            "index",
            shape.index.as_ref().map_or(Value::Null, |index| {
                Value::Array(index.iter().map(|&i| Value::Number(f64::from(i))).collect())
            }),
        ),
        (
            "kind",
            string(match shape.kind {
                Kind::Mesh => "mesh",
                Kind::Line => "line",
            }),
        ),
        ("name", string(name)),
        (
            "positions",
            Value::Array(
                shape
                    .positions
                    .iter()
                    .map(|&v| number(f64::from(v)))
                    .collect(),
            ),
        ),
        (
            "tag",
            if helper {
                string("helper")
            } else {
                Value::Null
            },
        ),
    ])
}

/// Every group's baked handle geometry and the drag plane's (built once).
pub fn geometry_json() -> Result<String, &'static str> {
    static JSON: OnceLock<Result<String, &'static str>> = OnceLock::new();
    JSON.get_or_init(|| {
        let all = geometry::groups();
        let group = |handles: &[Vec<geometry::Handle>; 3]| {
            object(
                ["translate", "rotate", "scale"]
                    .into_iter()
                    .zip(handles)
                    .map(|(mode, handles)| {
                        (
                            mode,
                            Value::Array(
                                handles
                                    .iter()
                                    .map(|h| shape_value(h.name, h.helper, &h.shape))
                                    .collect(),
                            ),
                        )
                    }),
            )
        };
        canonical(&object([
            ("gizmo", group(&all.gizmo)),
            ("helper", group(&all.helper)),
            ("picker", group(&all.picker)),
            ("plane", shape_value("", false, &all.plane)),
        ]))
    })
    .clone()
}

/// `transformFromObject`: the pose's position, normalized quaternion and scale.
fn transform_of(pose: &Pose) -> fields::Pose {
    fields::Pose {
        translation: pose.position,
        rotation: math::quat_normalize(pose.quaternion),
        scale: pose.scale,
    }
}

/// `gizmoDragChanges`: the proxy's transform for one origin, or every origin
/// carried around the proxy's pose at the press.
pub fn drag_changes(
    origins: &[Origin],
    initial: &Pose,
    current: &Pose,
    tool: Tool,
) -> Result<Vec<(Vec<u16>, fields::Pose)>, fields::Message> {
    let current = transform_of(current);
    if origins.len() > 1 {
        fields::project(origins, &transform_of(initial), &current, tool)
    } else {
        Ok(vec![(origins[0].instance_id.clone(), current)])
    }
}

fn transform(value: Value) -> Result<fields::Pose, &'static str> {
    let mut fields = members(value, &["rotation", "scale", "translationMm"])?;
    Ok(fields::Pose {
        translation: list(take(&mut fields, "translationMm"), finite)?,
        rotation: list(take(&mut fields, "rotation"), finite)?,
        scale: list(take(&mut fields, "scale"), finite)?,
    })
}

/// `{"initialProxy","mode","origins","proxy"}` → `{"changes"}` or
/// `{"error":"invalid_drag","message"}`.
pub fn changes_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(
        read(request)?,
        &["initialProxy", "mode", "origins", "proxy"],
    )?;
    let tool = match text(take(&mut fields, "mode"))?.as_str() {
        "move" => Tool::Move,
        "rotate" => Tool::Rotate,
        "scale" => Tool::Scale,
        _ => return Err(INVALID_REQUEST),
    };
    let Value::Array(entries) = take(&mut fields, "origins") else {
        return Err(INVALID_REQUEST);
    };
    if entries.is_empty() {
        return Err(INVALID_REQUEST);
    }
    let origins = entries
        .into_iter()
        .map(|entry| {
            let mut fields = members(entry, &["instanceId", "transform"])?;
            let Value::String(instance_id) = take(&mut fields, "instanceId") else {
                return Err(INVALID_REQUEST);
            };
            Ok(Origin {
                instance_id,
                pose: transform(take(&mut fields, "transform"))?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let initial = pose(take(&mut fields, "initialProxy"))?;
    let current = pose(take(&mut fields, "proxy"))?;
    let reply = match drag_changes(&origins, &initial, &current, tool) {
        Ok(changes) => object([(
            "changes",
            Value::Array(
                changes
                    .iter()
                    .map(|(id, pose)| {
                        object([
                            ("instanceId", Value::String(id.clone())),
                            (
                                "transform",
                                object([
                                    ("rotation", numbers(&pose.rotation)),
                                    ("scale", numbers(&pose.scale)),
                                    ("translationMm", numbers(&pose.translation)),
                                ]),
                            ),
                        ])
                    })
                    .collect(),
            ),
        )]),
        Err(message) => object([
            ("error", string(INVALID_DRAG)),
            ("message", Value::String(message)),
        ]),
    };
    canonical(&reply)
}
