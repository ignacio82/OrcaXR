//! The transform inspector's fields (`TransformFields.ts`, through
//! `TransformFieldsExchange.ts`): what the Move (mm), Rotate (deg) and Scale
//! (%) fields show for an instance's transform, and what an edit of the three
//! fields submits — the primary instance alone, or the selection carried
//! around it (`primaryTransformEdit` over `projectMultiInstanceTransform`),
//! each transform checked as the workspace checks it before submitting.
//!
//! Rotations follow three.js: `Euler.setFromQuaternion` (through
//! `Matrix4.makeRotationFromQuaternion`, the quaternion as given) in the
//! default XYZ order, and `Quaternion.setFromEuler(...).normalize()`, with
//! V8's `Math.sin`, `cos`, `asin` and `atan2` ([`crate::js_math`]). A field
//! shows `toFixed(2)` and reads `parseFloat(text) || 0`.
//!
//! The exchange is canonical JSON, a transform being
//! `{"rotation","scale","translationMm"}`: `fields_json` answers
//! `{"tool","transform"}` with `{"texts","values"}`; `edit_json` answers
//! `{"origins","primaryInstanceId","texts","tool"}` with `{"changes"}` or
//! `{"error":"invalid_edit","message"}`; `rotation_json` turns
//! `{"rotation"}` into `{"eulerRadians"}` and back. A value JSON cannot carry
//! is `null`; a malformed request is refused as `invalid_request`.
use crate::js_math::{
    self,
    convert::{parse_float, to_fixed},
};
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;
use std::f64::consts::PI;

pub use super::bed::{INPUT_LIMIT, INVALID_REQUEST, OUTPUT_LIMIT};
/// The code of an edit the workspace refuses.
pub const INVALID_EDIT: &str = "invalid_edit";

/// A transform tool with numeric fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    Move,
    Rotate,
    Scale,
}
impl Tool {
    /// The panel's title.
    pub fn title(self) -> &'static str {
        match self {
            Tool::Move => "Move (mm)",
            Tool::Rotate => "Rotate (deg)",
            Tool::Scale => "Scale (%)",
        }
    }
}

/// An instance transform: translation (mm), rotation `[x, y, z, w]`, scale.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pose {
    pub translation: [f64; 3],
    pub rotation: [f64; 4],
    pub scale: [f64; 3],
}

/// `THREE.MathUtils.clamp`: `Math.max(min, Math.min(max, value))`.
fn clamp(value: f64, min: f64, max: f64) -> f64 {
    js_math::max(min, js_math::min(max, value))
}

/// three's `new Euler().setFromQuaternion(new Quaternion().fromArray(q))`:
/// XYZ angles in radians of the rotation matrix the quaternion composes.
pub fn euler_from_quaternion(q: [f64; 4]) -> [f64; 3] {
    let [x, y, z, w] = q;
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    // `compose` with unit scale: multiplying by 1 changes nothing.
    let m11 = 1.0 - (yy + zz);
    let m12 = xy - wz;
    let m13 = xz + wy;
    let m22 = 1.0 - (xx + zz);
    let m23 = yz - wx;
    let m32 = yz + wx;
    let m33 = 1.0 - (xx + yy);
    let ey = js_math::asin(clamp(m13, -1.0, 1.0));
    if m13.abs() < 0.9999999 {
        [js_math::atan2(-m23, m33), ey, js_math::atan2(-m12, m11)]
    } else {
        [js_math::atan2(m32, m22), ey, 0.0]
    }
}

/// three's `new Quaternion().setFromEuler(new Euler(x, y, z)).normalize()`.
pub fn quaternion_from_euler(angles: [f64; 3]) -> [f64; 4] {
    let [x, y, z] = angles;
    let (c1, c2, c3) = (
        js_math::cos(x / 2.0),
        js_math::cos(y / 2.0),
        js_math::cos(z / 2.0),
    );
    let (s1, s2, s3) = (
        js_math::sin(x / 2.0),
        js_math::sin(y / 2.0),
        js_math::sin(z / 2.0),
    );
    let qx = s1 * c2 * c3 + c1 * s2 * s3;
    let qy = c1 * s2 * c3 - s1 * c2 * s3;
    let qz = c1 * c2 * s3 + s1 * s2 * c3;
    let qw = c1 * c2 * c3 - s1 * s2 * s3;
    let length = (qx * qx + qy * qy + qz * qz + qw * qw).sqrt();
    if length == 0.0 {
        [0.0, 0.0, 0.0, 1.0]
    } else {
        let inverse = 1.0 / length;
        [qx * inverse, qy * inverse, qz * inverse, qw * inverse]
    }
}

const RAD2DEG: f64 = 180.0 / PI;
const DEG2RAD: f64 = PI / 180.0;

/// `transformFieldValues`: millimetres, degrees of the XYZ angles, or percent.
pub fn field_values(tool: Tool, pose: &Pose) -> [f64; 3] {
    match tool {
        Tool::Move => pose.translation,
        Tool::Rotate => euler_from_quaternion(pose.rotation).map(|a| a * RAD2DEG),
        Tool::Scale => pose.scale.map(|s| s * 100.0),
    }
}

/// `transformFieldText`: two decimals.
pub fn field_text(value: f64) -> String {
    to_fixed(value, 2)
}

/// `transformFieldValue`: `parseFloat(text) || 0` over UTF-16 text.
pub fn field_value(text: &[u16]) -> f64 {
    // A lone surrogate is neither whitespace nor a digit, as U+FFFD is not.
    let value = parse_float(&String::from_utf16_lossy(text));
    if value.is_nan() || value == 0.0 {
        0.0
    } else {
        value
    }
}

/// `transformFieldInput`: millimetres, radians or scale factors.
pub fn field_input(tool: Tool, values: [f64; 3]) -> [f64; 3] {
    match tool {
        Tool::Move => values,
        Tool::Rotate => values.map(|d| d * DEG2RAD),
        Tool::Scale => values.map(|v| v / 100.0),
    }
}

/// `withTransformFieldInput`: the transform the tool's input sets.
pub fn with_field_input(tool: Tool, pose: &Pose, input: [f64; 3]) -> Pose {
    match tool {
        Tool::Move => Pose {
            translation: input,
            ..*pose
        },
        Tool::Rotate => Pose {
            rotation: quaternion_from_euler(input),
            ..*pose
        },
        Tool::Scale => Pose {
            scale: input,
            ..*pose
        },
    }
}

/// One instance of a selection and its transform before the edit.
#[derive(Debug, Clone, PartialEq)]
pub struct Origin {
    pub instance_id: Vec<u16>,
    pub pose: Pose,
}

/// A refusal in the workspace's words (UTF-16).
pub type Message = Vec<u16>;
fn message(text: &str) -> Message {
    text.encode_utf16().collect()
}
fn message_with(text: &str, id: &[u16]) -> Message {
    let mut out = message(text);
    out.extend_from_slice(id);
    out
}

fn add(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn subtract(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
fn multiply_components(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] * b[0], a[1] * b[1], a[2] * b[2]]
}
fn normalize(q: [f64; 4]) -> Result<[f64; 4], Message> {
    let length = js_math::hypot(&q);
    if !length.is_finite() || length == 0.0 {
        return Err(message(
            "A transform quaternion must be finite and non-zero",
        ));
    }
    Ok([q[0] / length, q[1] / length, q[2] / length, q[3] / length])
}
fn inverse(q: [f64; 4]) -> Result<[f64; 4], Message> {
    let [x, y, z, w] = normalize(q)?;
    Ok([-x, -y, -z, w])
}
fn multiply(l: [f64; 4], r: [f64; 4]) -> [f64; 4] {
    let [lx, ly, lz, lw] = l;
    let [rx, ry, rz, rw] = r;
    [
        lw * rx + lx * rw + ly * rz - lz * ry,
        lw * ry - lx * rz + ly * rw + lz * rx,
        lw * rz + lx * ry - ly * rx + lz * rw,
        lw * rw - lx * rx - ly * ry - lz * rz,
    ]
}
fn rotate(q: [f64; 4], v: [f64; 3]) -> Result<[f64; 3], Message> {
    let [x, y, z, w] = normalize(q)?;
    let uv = [
        y * v[2] - z * v[1],
        z * v[0] - x * v[2],
        x * v[1] - y * v[0],
    ];
    let uuv = [
        y * uv[2] - z * uv[1],
        z * uv[0] - x * uv[2],
        x * uv[1] - y * uv[0],
    ];
    Ok([
        v[0] + 2.0 * (w * uv[0] + uuv[0]),
        v[1] + 2.0 * (w * uv[1] + uuv[1]),
        v[2] + 2.0 * (w * uv[2] + uuv[2]),
    ])
}
fn validate_origins(origins: &[Origin]) -> Result<(), Message> {
    if origins.is_empty() {
        return Err(message(
            "A multi-instance transform requires at least one origin",
        ));
    }
    for (index, origin) in origins.iter().enumerate() {
        if origins[..index]
            .iter()
            .any(|o| o.instance_id == origin.instance_id)
        {
            return Err(message_with(
                "Multi-instance transform contains duplicate instance ",
                &origin.instance_id,
            ));
        }
    }
    Ok(())
}

/// `projectMultiInstanceTransform`: every origin carried by the pivot's
/// change from `initial` to `current` — moved by its translation, rotated
/// about it, or scaled in its initial axes, as `tool` says.
pub fn project(
    origins: &[Origin],
    initial: &Pose,
    current: &Pose,
    tool: Tool,
) -> Result<Vec<(Vec<u16>, Pose)>, Message> {
    validate_origins(origins)?;
    let initial_pivot = initial.translation;
    let current_pivot = current.translation;
    let translation_delta = subtract(current_pivot, initial_pivot);
    let initial_rotation = normalize(initial.rotation)?;
    let current_rotation = normalize(current.rotation)?;
    let rotation_delta = multiply(current_rotation, inverse(initial_rotation)?);
    if initial.scale.contains(&0.0) {
        return Err(message("A transform origin scale cannot contain zero"));
    }
    let ratio = [
        current.scale[0] / initial.scale[0],
        current.scale[1] / initial.scale[1],
        current.scale[2] / initial.scale[2],
    ];
    origins
        .iter()
        .map(|origin| {
            let pose = origin.pose;
            let moved = match tool {
                Tool::Move => Pose {
                    translation: add(pose.translation, translation_delta),
                    ..pose
                },
                Tool::Rotate => {
                    let relative = subtract(pose.translation, initial_pivot);
                    Pose {
                        translation: add(current_pivot, rotate(rotation_delta, relative)?),
                        rotation: normalize(multiply(rotation_delta, pose.rotation))?,
                        ..pose
                    }
                }
                Tool::Scale => {
                    let world = subtract(pose.translation, initial_pivot);
                    let local = rotate(inverse(initial_rotation)?, world)?;
                    let scaled = multiply_components(local, ratio);
                    Pose {
                        translation: add(current_pivot, rotate(initial_rotation, scaled)?),
                        scale: multiply_components(pose.scale, ratio),
                        ..pose
                    }
                }
            };
            Ok((origin.instance_id.clone(), moved))
        })
        .collect()
}

/// `primaryTransformEdit`: the changes a numeric edit of the primary submits —
/// that instance alone for a selection of one, else the selection carried
/// around it, the primary keeping exactly `current`.
pub fn primary_edit(
    origins: &[Origin],
    primary: &[u16],
    current: &Pose,
    tool: Tool,
) -> Result<Vec<(Vec<u16>, Pose)>, Message> {
    if origins.len() == 1 {
        return Ok(vec![(primary.to_vec(), *current)]);
    }
    validate_origins(origins)?;
    let Some(initial) = origins.iter().find(|o| o.instance_id == primary) else {
        return Err(message_with(
            "Multi-instance transform is missing primary instance ",
            primary,
        ));
    };
    let projected = project(origins, &initial.pose, current, tool)?;
    Ok(projected
        .into_iter()
        .map(|(id, pose)| {
            let pose = if id == primary { *current } else { pose };
            (id, pose)
        })
        .collect())
}

/// `cloneAndValidateTransform`: finite values, no zero scale, a non-zero rotation.
pub fn validate(pose: &Pose) -> Result<(), Message> {
    let values = pose
        .translation
        .iter()
        .chain(&pose.rotation)
        .chain(&pose.scale);
    if values.clone().any(|v| !v.is_finite()) {
        return Err(message(
            "Instance transform must contain finite translation, rotation, and scale values",
        ));
    }
    if pose.scale.iter().any(|v| v.abs() < 1e-12) {
        return Err(message("Instance transform scale cannot contain zero"));
    }
    let mut norm = 0.0;
    for value in pose.rotation {
        norm += value * value;
    }
    if norm < 1e-12 {
        return Err(message("Instance transform rotation cannot be zero"));
    }
    Ok(())
}

/// An edit of the three fields: the validated changes, or the workspace's message.
pub fn edit(
    tool: Tool,
    texts: [&[u16]; 3],
    origins: &[Origin],
    primary: &[u16],
) -> Result<Vec<(Vec<u16>, Pose)>, Message> {
    let initial = origins
        .iter()
        .find(|o| o.instance_id == primary)
        .map(|o| o.pose)
        .ok_or_else(|| message_with("Unknown instance ", primary))?;
    let values = texts.map(field_value);
    let current = with_field_input(tool, &initial, field_input(tool, values));
    let changes = primary_edit(origins, primary, &current, tool)?;
    for (_, pose) in &changes {
        validate(pose)?;
    }
    Ok(changes)
}

// --- Exchange ------------------------------------------------------------------------------

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
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
fn members(value: Value, keys: &[&str]) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    if fields.len() != keys.len() || !keys.iter().all(|k| fields.contains_key(&units(k))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn take(fields: &mut BTreeMap<Vec<u16>, Value>, key: &str) -> Value {
    fields.remove(&units(key)).unwrap_or(Value::Null)
}
fn finite_list<const N: usize>(value: Value) -> Result<[f64; N], &'static str> {
    let Value::Array(items) = value else {
        return Err(INVALID_REQUEST);
    };
    let items: [Value; N] = items.try_into().map_err(|_| INVALID_REQUEST)?;
    let mut out = [0.0; N];
    for (slot, item) in out.iter_mut().zip(items) {
        match item {
            Value::Number(n) if n.is_finite() => *slot = n,
            _ => return Err(INVALID_REQUEST),
        }
    }
    Ok(out)
}
fn text(value: Value) -> Result<Vec<u16>, &'static str> {
    match value {
        Value::String(units) => Ok(units),
        _ => Err(INVALID_REQUEST),
    }
}
fn tool(value: Value) -> Result<Tool, &'static str> {
    match text(value)?.as_slice() {
        t if t == units("move") => Ok(Tool::Move),
        t if t == units("rotate") => Ok(Tool::Rotate),
        t if t == units("scale") => Ok(Tool::Scale),
        _ => Err(INVALID_REQUEST),
    }
}
fn pose(value: Value) -> Result<Pose, &'static str> {
    let mut fields = members(value, &["rotation", "scale", "translationMm"])?;
    Ok(Pose {
        translation: finite_list(take(&mut fields, "translationMm"))?,
        rotation: finite_list(take(&mut fields, "rotation"))?,
        scale: finite_list(take(&mut fields, "scale"))?,
    })
}
fn pose_json(pose: &Pose) -> Value {
    object([
        ("rotation", numbers(&pose.rotation)),
        ("scale", numbers(&pose.scale)),
        ("translationMm", numbers(&pose.translation)),
    ])
}

/// `transformFieldsExchange`: `{"tool","transform"}` → `{"texts","values"}`.
pub fn fields_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["tool", "transform"])?;
    let tool = tool(take(&mut fields, "tool"))?;
    let values = field_values(tool, &pose(take(&mut fields, "transform"))?);
    canonical(&object([
        (
            "texts",
            Value::Array(
                values
                    .iter()
                    .map(|v| Value::String(units(&field_text(*v))))
                    .collect(),
            ),
        ),
        ("values", numbers(&values)),
    ]))
}

/// `transformFieldEditExchange`: `{"origins","primaryInstanceId","texts","tool"}`
/// → `{"changes"}` or `{"error":"invalid_edit","message"}`.
pub fn edit_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(
        read(request)?,
        &["origins", "primaryInstanceId", "texts", "tool"],
    )?;
    let tool = tool(take(&mut fields, "tool"))?;
    let Value::Array(texts) = take(&mut fields, "texts") else {
        return Err(INVALID_REQUEST);
    };
    let texts: [Value; 3] = texts.try_into().map_err(|_| INVALID_REQUEST)?;
    let [a, b, c] = texts;
    let texts = [text(a)?, text(b)?, text(c)?];
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
            Ok(Origin {
                instance_id: text(take(&mut fields, "instanceId"))?,
                pose: pose(take(&mut fields, "transform"))?,
            })
        })
        .collect::<Result<Vec<_>, &'static str>>()?;
    let primary = text(take(&mut fields, "primaryInstanceId"))?;
    if !origins.iter().any(|o| o.instance_id == primary) {
        return Err(INVALID_REQUEST);
    }
    let reply = match edit(tool, [&texts[0], &texts[1], &texts[2]], &origins, &primary) {
        Ok(changes) => object([(
            "changes",
            Value::Array(
                changes
                    .iter()
                    .map(|(id, pose)| {
                        object([
                            ("instanceId", Value::String(id.clone())),
                            ("transform", pose_json(pose)),
                        ])
                    })
                    .collect(),
            ),
        )]),
        Err(message) => object([
            ("error", Value::String(units(INVALID_EDIT))),
            ("message", Value::String(message)),
        ]),
    };
    canonical(&reply)
}

/// `transformRotationExchange`: `{"rotation"}` → `{"eulerRadians"}`, or
/// `{"eulerRadians"}` → `{"rotation"}`.
pub fn rotation_json(request: &str) -> Result<String, &'static str> {
    let request = read(request)?;
    let quaternion =
        matches!(&request, Value::Object(fields) if fields.contains_key(&units("rotation")));
    if quaternion {
        let mut fields = members(request, &["rotation"])?;
        let rotation = finite_list::<4>(take(&mut fields, "rotation"))?;
        return canonical(&object([(
            "eulerRadians",
            numbers(&euler_from_quaternion(rotation)),
        )]));
    }
    let mut fields = members(request, &["eulerRadians"])?;
    let angles = finite_list::<3>(take(&mut fields, "eulerRadians"))?;
    canonical(&object([(
        "rotation",
        numbers(&quaternion_from_euler(angles)),
    )]))
}
