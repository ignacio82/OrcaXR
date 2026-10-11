//! Renderer projection deltas against the browser: each distinct session trace
//! state opens as a native session and follows the browser host's script —
//! acknowledged edits and render pages in order — answering every page and
//! refusal byte for byte.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*, history::*, model::*, render, selection::*, session::*, validation::*,
};
use serde_json::Value;
use std::collections::BTreeMap;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/render-delta-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn session(
    state: &Value,
    generation: [u32; 4],
) -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let project_state =
        ProjectState::from_value(parse(state["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project =
        ValidatedProject::new(ProjectData::new(project_state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    assets
        .put(
            &parse(state["asset"]["descriptorJson"].as_str().unwrap()).unwrap(),
            &state["asset"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions {
            max_entries: state["options"]["maxEntries"].as_u64().unwrap_or(100) as usize,
            max_estimated_bytes: state["options"]["maxEstimatedBytes"]
                .as_u64()
                .unwrap_or(32 * 1024 * 1024),
        },
        generation,
    )
    .unwrap()
}
fn generation(f: &Value) -> [u32; 4] {
    let generation: Vec<u32> = f["generation"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g.as_u64().unwrap() as u32)
        .collect();
    generation.try_into().unwrap()
}

#[test]
fn render_pages_match_the_browser_over_live_sessions() {
    let f = fixture();
    let (mut pages, mut refusals, mut requests) = (0, 0, 0);
    for state in f["states"].as_array().unwrap() {
        let mut session = session(state, generation(&f));
        for (i, entry) in state["script"].as_array().unwrap().iter().enumerate() {
            let label = format!("{} step {i}", state["name"]);
            if let Some(request) = entry.get("request") {
                let reply = match session.submit(request.as_str().unwrap()) {
                    Submission::Ready(response) => response.into_parts().0,
                    Submission::Queued { .. } => session.run_next().unwrap().into_parts().0,
                };
                let actual: Value = serde_json::from_str(&reply).unwrap();
                let expected: Value =
                    serde_json::from_str(entry["reply"].as_str().unwrap()).unwrap();
                assert_eq!(actual, expected, "{label} reply");
                requests += 1;
                continue;
            }
            let request = wire::decode_render_request(entry["render"].as_str().unwrap()).unwrap();
            let answer = session.render_page(&request);
            if let Some(page) = entry.get("page") {
                assert_eq!(
                    wire::encode_render_page(&answer.unwrap()).unwrap(),
                    page.as_str().unwrap(),
                    "{label}"
                );
                pages += 1;
            } else {
                assert_eq!(
                    answer.map(|_| ()).map_err(|r| r.code()),
                    Err(entry["refusal"].as_str().unwrap()),
                    "{label}"
                );
                refusals += 1;
            }
        }
    }
    assert_eq!((pages, refusals, requests), (313, 57, 265));
}

/// A disposed session releases what it retained and answers nothing.
#[test]
fn a_disposed_session_refuses_render_pages() {
    let f = fixture();
    let state = &f["states"][0];
    let mut session = session(state, generation(&f));
    let request = wire::RenderRequest {
        base: wire::OptionalRenderCursor::Absent(wire::Empty {}),
        target: wire::OptionalRenderCursor::Absent(wire::Empty {}),
        start: 0,
        count: render::MAX_PAGE,
    };
    let page = session.render_page(&request).unwrap();
    assert_eq!(page.changes.len() as u64, page.total.min(render::MAX_PAGE));
    session.dispose();
    assert_eq!(
        session.render_page(&request).map(|_| ()),
        Err(render::Refusal::Disposed)
    );
}

#[derive(Debug, Default, PartialEq)]
struct Scene {
    plates: BTreeMap<Vec<u16>, render::RenderPlate>,
    instances: BTreeMap<Vec<u16>, render::RenderInstance>,
    volumes: BTreeMap<Vec<u16>, render::RenderVolume>,
}
impl Scene {
    fn of(projection: &render::RenderProjection) -> Self {
        let mut scene = Self::default();
        scene.apply(&render::diff(None, projection));
        scene
    }
    fn apply(&mut self, changes: &[render::RenderChange]) {
        use render::RenderChange as C;
        for change in changes {
            match change {
                C::Plate(p) => drop(self.plates.insert(p.plate_id.to_vec(), p.clone())),
                C::Instance(i) => drop(self.instances.insert(i.instance_id.to_vec(), i.clone())),
                C::Volume(v) => drop(self.volumes.insert(v.volume_id.to_vec(), v.clone())),
                C::RemovePlate(id) => assert!(self.plates.remove(&id[..]).is_some()),
                C::RemoveInstance(id) => assert!(self.instances.remove(&id[..]).is_some()),
                C::RemoveVolume(id) => assert!(self.volumes.remove(&id[..]).is_some()),
            }
        }
    }
}

/// Every delta between two corpus projects, applied to its base, reproduces
/// the target; a project against itself has no changes; a sync from empty
/// holds exactly one record per entity.
#[test]
fn deltas_apply_to_their_base() {
    let f = fixture();
    let projections: Vec<_> = f["states"]
        .as_array()
        .unwrap()
        .iter()
        .map(|state| {
            render::project(
                &ProjectState::from_value(parse(state["stateJson"].as_str().unwrap()).unwrap())
                    .unwrap(),
            )
        })
        .collect();
    for base in &projections {
        assert!(render::diff(Some(base), base).is_empty());
        assert_eq!(
            render::diff(None, base).len(),
            base.plates.len() + base.instances.len() + base.volumes.len()
        );
        for target in &projections {
            let mut scene = Scene::of(base);
            scene.apply(&render::diff(Some(base), target));
            assert_eq!(scene, Scene::of(target));
        }
    }
}
