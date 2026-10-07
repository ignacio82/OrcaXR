use super::*;
fn whitespace(n: u16) -> bool {
    matches!(n,0x09..=0x0d|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn trim(mut text: &[u16]) -> &[u16] {
    while text.first().is_some_and(|&v| whitespace(v)) {
        text = &text[1..];
    }
    while text.last().is_some_and(|&v| whitespace(v)) {
        text = &text[..text.len() - 1];
    }
    text
}
pub(super) fn color(value: &[u16]) -> [u16; 9] {
    let mut v = trim(value);
    if v.first() == Some(&35) {
        v = &v[1..];
    }
    let mut out = [35, 67, 67, 67, 67, 67, 67, 70, 70];
    if !matches!(v.len(), 6 | 8) || !v.iter().all(|&n| matches!(n,48..=57|65..=70|97..=102)) {
        return out;
    }
    for (i, &v) in v.iter().enumerate() {
        out[i + 1] = if (97..=102).contains(&v) { v - 32 } else { v };
    }
    out
}
fn coordinate(v: &[u16]) -> Option<f64> {
    let v = trim(v);
    let mut cursor = usize::from(v.first() == Some(&45));
    let mut digits = 0;
    while cursor < v.len() && (48..=57).contains(&v[cursor]) {
        cursor += 1;
        digits += 1;
    }
    if v.get(cursor) == Some(&46) {
        cursor += 1;
        while cursor < v.len() && (48..=57).contains(&v[cursor]) {
            cursor += 1;
            digits += 1;
        }
    }
    if digits == 0 || cursor != v.len() {
        return None;
    }
    // Input text is charged before this bounded temporary ASCII conversion.
    let bytes: Vec<u8> = v.iter().map(|&v| v as u8).collect();
    let n = std::str::from_utf8(&bytes).ok()?.parse::<f64>().ok()?;
    n.is_finite().then_some(n)
}
fn size(
    value: Option<&Value>,
    budget: &mut Budget,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Option<[f64; 2]>, Error> {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut count = 0;
    let mut point = |units: &[u16]| -> Result<(), Error> {
        check(cancelled)?;
        let Some(x) = units.iter().position(|&n| n == 120 || n == 88) else {
            return Ok(());
        };
        if let (Some(x), Some(y)) = (coordinate(&units[..x]), coordinate(&units[x + 1..])) {
            count += 1;
            min[0] = min[0].min(x);
            max[0] = max[0].max(x);
            min[1] = min[1].min(y);
            max[1] = max[1].max(y);
        }
        Ok(())
    };
    match value {
        Some(Value::Array(values)) => {
            for v in values {
                budget.record()?;
                if let Value::String(v) = v {
                    budget.text(v)?;
                    point(v)?;
                }
            }
        }
        Some(Value::String(v)) => {
            budget.text(v)?;
            for v in v.split(|&n| n == 44 || n == 59) {
                budget.record()?;
                point(v)?;
            }
        }
        _ => {}
    }
    let size = [max[0] - min[0], max[1] - min[1]];
    Ok((count >= 2 && size[0] > 0.0 && size[1] > 0.0).then_some(size))
}
pub(super) fn origins(
    state: &ProjectState,
    plates: &[&ProjectPlate],
    budget: &mut Budget,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Vec<[f64; 2]>, Error> {
    if plates.len() <= 1 {
        return Ok(vec![[0.0, 0.0]; plates.len()]);
    }
    let Some(size) = size(
        field(state.config.value(), "printable_area"),
        budget,
        cancelled,
    )?
    else {
        for plate in plates.iter().skip(1) {
            for object in plate.objects.iter() {
                check(cancelled)?;
                budget.record()?;
                if !object.instances.is_empty() {
                    return Err(Error::MissingPrintableArea);
                }
            }
        }
        return Ok(vec![[0.0, 0.0]; plates.len()]);
    };
    let columns = (plates.len() as f64).sqrt().ceil() as usize;
    Ok((0..plates.len())
        .map(|i| {
            let row = i / columns;
            let column = i % columns;
            [
                column as f64 * size[0] * 1.2,
                if row == 0 {
                    0.0
                } else {
                    -(row as f64) * size[1] * 1.2
                },
            ]
        })
        .collect())
}
