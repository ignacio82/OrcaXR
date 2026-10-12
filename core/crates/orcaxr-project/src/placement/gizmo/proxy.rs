//! Where the gizmo's proxy stands for a selection (`transformProxy.ts`,
//! through `TransformProxyExchange.ts`), as `OrcaWorkspace.syncTransformProxy`
//! places it and `captureSelectedInstanceOrigins` captures a drag's origins:
//! the primary instance and the selected instances on its plate (the primary
//! alone when the selection leaves it out), and the proxy at one instance's own
//! pose (three's `Quaternion.normalize` of its rotation) or at the centre of
//! the selection's bounds (`computeCanonicalInstanceBounds` over every volume
//! role), unrotated at unit scale.
use super::{INVALID_REQUEST, canonical, members, numbers, object, read, string, take};
use crate::assets::AssetRepository;
use crate::ids::InstanceId;
use crate::model::{ProjectState, Transform, VolumeRole, find_instance};
use orcaxr_contracts::canonical::Value;

/// The code of a selection whose proxy the workspace cannot place.
pub const INVALID_PROXY: &str = "invalid_proxy";

/// Every volume role: the proxy measures a selection whole.
const ROLES: [VolumeRole; 5] = [
    VolumeRole::Model,
    VolumeRole::ParameterModifier,
    VolumeRole::NegativeVolume,
    VolumeRole::SupportEnforcer,
    VolumeRole::SupportBlocker,
];

/// `getInstance`: an instance's plate and transform, if the project has it.
fn instance<'a>(state: &'a ProjectState, id: &[u16]) -> Option<(&'a [u16], &'a Transform)> {
    let id = InstanceId::try_from_utf16(id.to_vec()).ok()?;
    find_instance(state, &id).map(|(plate, _, instance)| (plate.id.as_utf16(), &instance.transform))
}

fn units(value: Value) -> Result<Vec<u16>, &'static str> {
    match value {
        Value::String(units) => Ok(units),
        _ => Err(INVALID_REQUEST),
    }
}

fn transform_value(transform: &Transform) -> Value {
    object([
        ("rotation", numbers(&transform.rotation.map(|v| v.get()))),
        ("scale", numbers(&transform.scale.map(|v| v.get()))),
        (
            "translationMm",
            numbers(&transform.translation_mm.map(|v| v.get())),
        ),
    ])
}

/// `{"primaryInstanceId","selectedInstanceIds"}` → `{"origins","primaryInstanceId","proxy"}`,
/// `{"proxy":null}` without a primary instance the project has, or
/// `{"error":"invalid_proxy","message"}` when the selection's bounds cannot be measured.
pub fn proxy_json(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &str,
) -> Result<String, &'static str> {
    let mut fields = members(
        read(request)?,
        &["primaryInstanceId", "selectedInstanceIds"],
    )?;
    let primary = match take(&mut fields, "primaryInstanceId") {
        Value::Null => None,
        value => Some(units(value)?),
    };
    let Value::Array(selected) = take(&mut fields, "selectedInstanceIds") else {
        return Err(INVALID_REQUEST);
    };
    let selected = selected
        .into_iter()
        .map(units)
        .collect::<Result<Vec<_>, _>>()?;
    let none = || canonical(&object([("proxy", Value::Null)]));
    // `if (!primaryInstanceId)`: no primary, or an empty one.
    let Some(primary) = primary.filter(|id| !id.is_empty()) else {
        return none();
    };
    let Some((plate, primary_transform)) = instance(state, &primary) else {
        return none();
    };
    let ids = if selected.contains(&primary) {
        selected
    } else {
        vec![primary.clone()]
    };
    let origins: Vec<(Vec<u16>, &Transform)> = ids
        .iter()
        .filter_map(|id| {
            instance(state, id)
                .filter(|(on, _)| *on == plate)
                .map(|(_, transform)| (id.clone(), transform))
        })
        .collect();
    let (position, quaternion, scale) = if origins.len() > 1 {
        let ids: Vec<Vec<u16>> = origins.iter().map(|(id, _)| id.clone()).collect();
        match super::super::bounds_with(state, &assets.capture_internal(), &ids, None, &ROLES) {
            Ok(bounds) => (
                [
                    (bounds.min[0] + bounds.max[0]) / 2.0,
                    (bounds.min[1] + bounds.max[1]) / 2.0,
                    (bounds.min[2] + bounds.max[2]) / 2.0,
                ],
                super::math::IDENTITY_QUATERNION,
                [1.0, 1.0, 1.0],
            ),
            Err(refusal) => {
                return canonical(&object([
                    ("error", string(INVALID_PROXY)),
                    ("message", string(&refusal.message)),
                ]));
            }
        }
    } else {
        (
            primary_transform.translation_mm.map(|v| v.get()),
            super::math::quat_normalize(primary_transform.rotation.map(|v| v.get())),
            primary_transform.scale.map(|v| v.get()),
        )
    };
    canonical(&object([
        (
            "origins",
            Value::Array(
                origins
                    .iter()
                    .map(|(id, transform)| {
                        object([
                            ("instanceId", Value::String(id.clone())),
                            ("transform", transform_value(transform)),
                        ])
                    })
                    .collect(),
            ),
        ),
        ("primaryInstanceId", Value::String(primary)),
        (
            "proxy",
            object([
                ("position", numbers(&position)),
                ("quaternion", numbers(&quaternion)),
                ("scale", numbers(&scale)),
            ]),
        ),
    ]))
}
