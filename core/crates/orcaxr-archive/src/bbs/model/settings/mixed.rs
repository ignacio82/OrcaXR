use super::*;
// Adding 0.5 before flooring can itself round upward below a half boundary.
// These quantities are nonnegative; compare the exact fractional remainder.
fn round_nonnegative(n: f64) -> f64 {
    let floor = n.floor();
    if n - floor >= 0.5 { floor + 1.0 } else { floor }
}
pub(super) enum Row<'a> {
    Standard {
        filament: &'a MixedFilament,
        percentages: Vec<f64>,
        gradient: Option<[f64; 2]>,
        stable: u64,
    },
    Exact {
        filament: &'a MixedFilament,
        recipe: &'a FullSpectrumRecipeState,
        a: usize,
        b: usize,
        mix_b: f64,
    },
}
fn slot(physical: &BTreeMap<&[u16], usize>, id: &[u16]) -> Result<usize, Error> {
    physical.get(id).copied().ok_or(Error::Recipe)
}
fn stable_id(units: &[u16], c: &mut impl FnMut() -> bool) -> Result<u64, Error> {
    let mut hash = 0xcbf29ce484222325u64;
    for (i, ch) in char::decode_utf16(units.iter().copied()).enumerate() {
        if i.is_multiple_of(256) {
            check(c)?;
        }
        for b in ch
            .unwrap_or(char::REPLACEMENT_CHARACTER)
            .encode_utf8(&mut [0; 4])
            .bytes()
        {
            hash = (hash ^ u64::from(b)).wrapping_mul(0x100000001b3);
        }
    }
    Ok(hash)
}
fn percentages(
    f: &MixedFilament,
    budget: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<Vec<f64>, Error> {
    budget.derived(
        f.components
            .len()
            .checked_mul(2)
            .ok_or(Error::ResourceLimit)?,
    )?;
    let mut total = 0.0f64;
    let mut maximum = 0.0f64;
    for component in f.components.iter() {
        check(c)?;
        total += component.weight.get();
        maximum = maximum.max(component.weight.get());
    }
    let mut result = Vec::new();
    for component in f.components.iter() {
        check(c)?;
        result.push(100.0 * component.weight.get() / total);
    }
    if !total.is_finite() || result.iter().any(|n| !n.is_finite()) {
        total = 0.0;
        for (component, v) in f.components.iter().zip(&mut result) {
            check(c)?;
            *v = component.weight.get() / maximum;
            total += *v;
        }
        for v in &mut result {
            check(c)?;
            *v = 100.0 * *v / total;
        }
    }
    let mut order = Vec::new();
    let mut sum = 0.0;
    for (i, v) in result.iter_mut().enumerate() {
        check(c)?;
        if !v.is_finite() {
            return Err(Error::Recipe);
        }
        let integer = v.floor();
        order.push((i, *v - integer));
        *v = integer;
        sum += integer;
    }
    order.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap().then(a.0.cmp(&b.0)));
    let remainder = 100.0 - sum;
    if remainder > 100.0 {
        return Err(Error::Recipe);
    }
    for i in 0..(remainder.max(0.0) as usize) {
        check(c)?;
        let index = order[i % order.len()].0;
        result[index] += 1.0;
    }
    Ok(result)
}
fn endpoint(weights: &[Number], fallback: f64, c: &mut impl FnMut() -> bool) -> Result<f64, Error> {
    let mut total = 0.0;
    let mut maximum = 0.0f64;
    for n in weights {
        check(c)?;
        total += n.get();
        maximum = maximum.max(n.get());
    }
    if total == 0.0 {
        return Ok(fallback);
    }
    if total.is_finite() {
        return Ok(weights[0].get() / total);
    }
    let mut scaled_total = 0.0;
    for n in weights {
        check(c)?;
        scaled_total += n.get() / maximum;
    }
    Ok((weights[0].get() / maximum) / scaled_total)
}
pub(super) fn prepare<'a>(
    state: &'a ProjectState,
    physical: &BTreeMap<&[u16], usize>,
    warnings: &mut Vec<Warning>,
    budget: &mut Budget,
    c: &mut impl FnMut() -> bool,
) -> Result<Vec<Row<'a>>, Error> {
    let mut rows = Vec::new();
    for (index, f) in state.filaments.mixed.iter().enumerate() {
        check(c)?;
        budget.record()?;
        budget.derived(1)?;
        budget.text(f.id.as_utf16())?;
        for component in f.components.iter() {
            check(c)?;
            budget.record()?;
            budget.text(component.filament_id.as_utf16())?;
            slot(physical, component.filament_id.as_utf16())?;
        }
        if let Some(recipe) = &f.full_spectrum {
            if !(2..=64).contains(&physical.len()) {
                return Err(Error::Recipe);
            }
            budget.text(recipe.upstream_stable_id.units())?;
            budget.text(recipe.component_a_id.as_utf16())?;
            budget.text(recipe.component_b_id.as_utf16())?;
            let mut a = slot(physical, recipe.component_a_id.as_utf16())?;
            let mut b = slot(physical, recipe.component_b_id.as_utf16())?;
            if a == b {
                return Err(Error::Recipe);
            }
            let mut used_first = false;
            let mut used_second = false;
            let mut first_not_second = None;
            for group in recipe.manual_pattern_groups.iter() {
                check(c)?;
                budget.record()?;
                if group.is_empty() {
                    return Err(Error::Recipe);
                }
                for id in group.iter() {
                    check(c)?;
                    budget.record()?;
                    budget.text(id.as_utf16())?;
                    let n = slot(physical, id.as_utf16())?;
                    used_first |= n == 1;
                    used_second |= n == 2;
                    if n != 2 && first_not_second.is_none() {
                        first_not_second = Some(n);
                    }
                }
            }
            let mut mix_b = recipe.mix_b_percent.get();
            if !recipe.manual_pattern_groups.is_empty() {
                a = if used_first {
                    1
                } else {
                    first_not_second.unwrap_or(1)
                };
                b = if used_second {
                    2
                } else {
                    let mut found = None;
                    'groups: for group in recipe.manual_pattern_groups.iter() {
                        for id in group.iter() {
                            check(c)?;
                            let n = slot(physical, id.as_utf16())?;
                            if n != a {
                                found = Some(n);
                                break 'groups;
                            }
                        }
                    }
                    found.unwrap_or(if a == 1 { 2 } else { 1 })
                };
                let mut mean = 0.0;
                for group in recipe.manual_pattern_groups.iter() {
                    let mut count = 0usize;
                    for id in group.iter() {
                        check(c)?;
                        let n = slot(physical, id.as_utf16())?;
                        if n == b {
                            count += 1;
                        }
                        if n <= 2 && n != a && n != b {
                            return Err(Error::Recipe);
                        }
                    }
                    mean += count as f64 / group.len() as f64;
                }
                // All values are nonnegative: JS Math.round uses upward ties.
                mix_b = round_nonnegative(100.0 * mean / recipe.manual_pattern_groups.len() as f64);
            }
            for id in recipe.gradient_component_ids.iter() {
                check(c)?;
                budget.record()?;
                budget.text(id.as_utf16())?;
                slot(physical, id.as_utf16())?;
            }
            for _ in recipe.gradient_component_weights.iter() {
                check(c)?;
                budget.record()?;
            }
            rows.push(Row::Exact {
                filament: f,
                recipe,
                a,
                b,
                mix_b,
            });
        } else {
            if f.components.len() < 2 {
                return Err(Error::Recipe);
            }
            let percentages = percentages(f, budget, c)?;
            let gradient = match &f.distribution {
                MixedDistribution::Gradient(d) => {
                    for _ in d.start_weights.iter().chain(d.end_weights.iter()) {
                        check(c)?;
                        budget.record()?;
                    }
                    warnings.push(Warning::ApproximateGradient { mixed: index });
                    Some([
                        endpoint(&d.start_weights, 0.8, c)?,
                        endpoint(&d.end_weights, 0.2, c)?,
                    ])
                }
                MixedDistribution::Cycle(_) => {
                    warnings.push(Warning::ApproximateCycle { mixed: index });
                    None
                }
                MixedDistribution::Match(_) => {
                    warnings.push(Warning::ApproximateMatch { mixed: index });
                    None
                }
                _ => None,
            };
            rows.push(Row::Standard {
                filament: f,
                percentages,
                gradient,
                stable: stable_id(f.id.as_utf16(), c)?,
            });
        }
    }
    Ok(rows)
}
fn gradient<W: Write, C: FnMut() -> bool>(
    start: f64,
    end: f64,
    w: &mut json::Writer<'_, W, C>,
) -> Result<(), Error> {
    w.raw(b",r1/")?;
    w.raw(numbers::fixed4(start).map_err(Error::Number)?.as_bytes())?;
    w.raw(b"/")?;
    w.raw(numbers::fixed4(end).map_err(Error::Number)?.as_bytes())
}
fn offset<W: Write, C: FnMut() -> bool>(
    n: f64,
    w: &mut json::Writer<'_, W, C>,
) -> Result<(), Error> {
    let fixed = numbers::fixed4(n).map_err(Error::Number)?;
    let text = fixed.as_str().trim_end_matches('0').trim_end_matches('.');
    w.raw(if text == "-0" || text.is_empty() {
        b"0"
    } else {
        text.as_bytes()
    })
}
pub(super) fn write<W: Write, C: FnMut() -> bool>(
    row: &Row<'_>,
    physical: &BTreeMap<&[u16], usize>,
    w: &mut json::Writer<'_, W, C>,
) -> Result<(), Error> {
    match row {
        Row::Standard {
            filament: f,
            percentages,
            gradient: g,
            stable,
        } => {
            w.unsigned(slot(physical, f.components[0].filament_id.as_utf16())? as u64)?;
            w.raw(b",")?;
            w.unsigned(slot(physical, f.components[1].filament_id.as_utf16())? as u64)?;
            w.raw(if f.enabled { b",1,1," } else { b",0,1," })?;
            w.number(percentages[1].clamp(0.0, 100.0))?;
            w.raw(b",0,g")?;
            let mut slashes = false;
            for component in f.components.iter() {
                w.poll()?;
                slashes |= slot(physical, component.filament_id.as_utf16())? > 9;
            }
            for (i, component) in f.components.iter().enumerate() {
                if i != 0 && slashes {
                    w.raw(b"/")?;
                }
                w.unsigned(slot(physical, component.filament_id.as_utf16())? as u64)?;
            }
            w.raw(b",w")?;
            for (i, n) in percentages.iter().enumerate() {
                if i != 0 {
                    w.raw(b"/")?;
                }
                w.number(*n)?;
            }
            let (mode, ui) = match f.distribution {
                MixedDistribution::Ratio(_) => (2, 0),
                MixedDistribution::Cycle(_) => (0, 1),
                MixedDistribution::Match(_) => (2, 2),
                MixedDistribution::Gradient(_) => (2, 3),
            };
            w.raw(b",m")?;
            w.unsigned(mode)?;
            w.raw(b",z0,xa0,xb0,d0,o0,u")?;
            w.unsigned(*stable)?;
            w.raw(b",cm")?;
            w.unsigned(ui)?;
            if let Some([a, b]) = g {
                gradient(*a, *b, w)?;
            }
            if matches!(f.distribution, MixedDistribution::Cycle(_)) {
                let mut first = true;
                w.raw(b",")?;
                for (component, n) in f.components.iter().zip(percentages) {
                    let repeats = round_nonnegative(n / 10.0).max(1.0) as usize;
                    for _ in 0..repeats {
                        if !first {
                            w.raw(b"/")?;
                        }
                        first = false;
                        w.unsigned(slot(physical, component.filament_id.as_utf16())? as u64)?;
                    }
                }
            }
        }
        Row::Exact {
            filament: f,
            recipe: r,
            a,
            b,
            mix_b,
        } => {
            w.unsigned(*a as u64)?;
            w.raw(b",")?;
            w.unsigned(*b as u64)?;
            w.raw(if f.enabled { b",1," } else { b",0," })?;
            w.raw(if r.custom { b"1," } else { b"0," })?;
            w.number(*mix_b)?;
            w.raw(b",0,g")?;
            let mut slashes = false;
            for id in r.gradient_component_ids.iter() {
                w.poll()?;
                slashes |= slot(physical, id.as_utf16())? > 9;
            }
            for (i, id) in r.gradient_component_ids.iter().enumerate() {
                if i != 0 && slashes {
                    w.raw(b"/")?;
                }
                w.unsigned(slot(physical, id.as_utf16())? as u64)?;
            }
            w.raw(b",w")?;
            for (i, n) in r.gradient_component_weights.iter().enumerate() {
                if i != 0 {
                    w.raw(b"/")?;
                }
                w.number(n.get())?;
            }
            w.raw(b",m")?;
            w.number(r.distribution_mode.number())?;
            w.raw(b",z")?;
            w.number(r.local_z_max_sublayers.get())?;
            w.raw(b",xa")?;
            offset(r.component_a_surface_offset_mm.get(), w)?;
            w.raw(b",xb")?;
            offset(r.component_b_surface_offset_mm.get(), w)?;
            w.raw(if r.deleted { b",d1" } else { b",d0" })?;
            w.raw(if r.origin_auto { b",o1,u" } else { b",o0,u" })?;
            w.contents(r.upstream_stable_id.units())?;
            if r.ui_mode.number() >= 0.0 {
                w.raw(b",cm")?;
                w.number(r.ui_mode.number())?;
            }
            if r.gradient_enabled {
                gradient(r.gradient_start.get(), r.gradient_end.get(), w)?;
            }
            // One group means no separator; two or more groups retain commas.
            if !r.manual_pattern_groups.is_empty() {
                w.raw(b",")?;
                for (gi, group) in r.manual_pattern_groups.iter().enumerate() {
                    if gi != 0 {
                        w.raw(b",")?;
                    }
                    for id in group.iter() {
                        let n = slot(physical, id.as_utf16())?;
                        if n == *a {
                            w.raw(b"1")?;
                        } else if n == *b {
                            w.raw(b"2")?;
                        } else {
                            if n >= 10 {
                                w.raw(b"[")?;
                            }
                            w.unsigned(n as u64)?;
                            if n >= 10 {
                                w.raw(b"]")?;
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}
