use super::*;
use orcaxr_contracts::canonical::Value;
fn field<'a>(v: &'a Value, name: &str) -> Option<&'a Value> {
    let Value::Object(fields) = v else {
        return None;
    };
    let mut key = [0u16; 16];
    if name.len() > key.len() {
        return None;
    }
    for (a, b) in key.iter_mut().zip(name.bytes()) {
        *a = u16::from(b);
    }
    fields.get(&key[..name.len()])
}
fn reference<'a>(
    id: &'a [u16],
    refs: &mut BTreeSet<&'a [u16]>,
    budget: &mut Budget,
) -> Result<(), Error> {
    budget.text(id.len())?;
    refs.insert(id);
    Ok(())
}
fn assigned<'a>(
    value: &'a Value,
    refs: &mut BTreeSet<&'a [u16]>,
    budget: &mut Budget,
) -> Result<(), Error> {
    if let Value::String(v) = value {
        reference(v, refs, budget)?;
    }
    Ok(())
}
fn assignments<'a>(
    v: &'a Value,
    refs: &mut BTreeSet<&'a [u16]>,
    budget: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    if let Value::Array(rows) = v {
        for row in rows {
            check(c)?;
            budget.record()?;
            if let Some(v) = field(row, "value") {
                assigned(v, refs, budget)?;
            }
        }
    }
    Ok(())
}
fn node<'a>(
    v: &'a Value,
    refs: &mut BTreeSet<&'a [u16]>,
    budget: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    check(c)?;
    budget.record()?;
    if matches!(field(v,"kind"),Some(Value::String(k)) if eq(k,"split")) {
        if let Some(Value::Array(children)) = field(v, "children") {
            for child in children {
                node(child, refs, budget, c)?;
            }
        }
    } else if matches!(field(v,"kind"),Some(Value::String(k)) if eq(k,"leaf"))
        && let Some(state) = field(v, "state")
        && matches!(field(state,"kind"),Some(Value::String(k)) if eq(k,"assigned"))
        && let Some(v) = field(state, "value")
    {
        assigned(v, refs, budget)?;
    }
    Ok(())
}
pub(super) fn global<'a>(
    state: &'a ProjectState,
    warnings: &mut Vec<Warning<'a>>,
    limits: Limits,
    budget: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    let mut slots = BTreeSet::new();
    let mut refs = BTreeSet::new();
    for f in state.filaments.physical.iter() {
        check(c)?;
        budget.record()?;
        reference(f.id.as_utf16(), &mut slots, budget)?;
    }
    for f in state.filaments.mixed.iter() {
        check(c)?;
        budget.record()?;
        if f.enabled {
            reference(f.id.as_utf16(), &mut slots, budget)?;
        }
    }
    for p in state.plates.iter() {
        check(c)?;
        budget.record()?;
        if let Some(id) = p.wipe_tower.as_ref().and_then(|t| t.filament_id.as_ref()) {
            reference(id.as_utf16(), &mut refs, budget)?;
        }
        for o in p.objects.iter() {
            check(c)?;
            budget.record()?;
            if let Some(id) = &o.filament_id {
                reference(id.as_utf16(), &mut refs, budget)?;
            }
            for r in o.layer_ranges.iter() {
                check(c)?;
                budget.record()?;
                if let Some(id) = &r.filament_id {
                    reference(id.as_utf16(), &mut refs, budget)?;
                }
            }
            for v in o.volumes.iter() {
                check(c)?;
                budget.record()?;
                if let Some(id) = &v.filament_id {
                    reference(id.as_utf16(), &mut refs, budget)?;
                }
                assignments(v.annotations.color.value(), &mut refs, budget, c)?;
                if let Some(channel) = v
                    .annotations
                    .refinement
                    .as_ref()
                    .and_then(|r| field(r.value(), "color"))
                {
                    if let Some(rows) = field(channel, "assignments") {
                        assignments(rows, &mut refs, budget, c)?;
                    }
                    if let Some(Value::Array(splits)) = field(channel, "splits") {
                        for split in splits {
                            check(c)?;
                            budget.record()?;
                            if let Some(v) = field(split, "node") {
                                node(v, &mut refs, budget, c)?;
                            }
                        }
                    }
                }
            }
        }
    }
    for id in refs {
        if !slots.contains(id) {
            push(warnings, Warning::UnavailableFilament(id), limits.warnings)?;
        }
    }
    let mut hooks = false;
    for g in state.custom_gcode.iter() {
        check(c)?;
        budget.record()?;
        hooks |= g.layer_event.is_none();
    }
    if hooks {
        push(warnings, Warning::CustomHooks, limits.warnings)?;
    }
    if state.extension_data.is_some() || !state.extension_blobs.is_empty() {
        push(warnings, Warning::Extensions, limits.warnings)?;
    }
    Ok(())
}
