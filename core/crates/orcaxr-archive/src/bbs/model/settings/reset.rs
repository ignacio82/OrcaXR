use super::*;
fn units(v: Option<&Value>) -> &[u16] {
    match v {
        Some(Value::String(v)) => v,
        _ => &[],
    }
}
fn flavor(v: Option<&Value>) -> bool {
    let Some(Value::String(v)) = v else {
        return true;
    };
    // Only these ASCII case variants lowercase to the two accepted names.
    [b"marlin".as_slice(), b"marlin2"].iter().any(|target| {
        v.len() == target.len()
            && v.iter()
                .zip(*target)
                .all(|(&u, &b)| u == u16::from(b) || u == u16::from(b.to_ascii_uppercase()))
    })
}
fn skip(
    v: &[u16],
    i: &mut usize,
    accepts: impl Fn(u16) -> bool,
    c: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    while v.get(*i).is_some_and(|&u| accepts(u)) {
        if i.is_multiple_of(256) {
            check(c)?;
        }
        *i += 1;
    }
    Ok(())
}
fn line(v: &[u16], c: &mut impl FnMut() -> bool) -> Result<bool, Error> {
    let mut i = 0;
    let space = |u| matches!(u, 9 | 32);
    skip(v, &mut i, space, c)?;
    if !matches!(v.get(i), Some(71 | 103)) || v.get(i + 1) != Some(&57) || v.get(i + 2) != Some(&50)
    {
        return Ok(false);
    }
    i += 3;
    skip(v, &mut i, space, c)?;
    if !matches!(v.get(i), Some(69 | 101)) {
        return Ok(false);
    }
    i += 1;
    if v.get(i) == Some(&48) {
        i += 1;
        if v.get(i) == Some(&46) {
            i += 1;
            skip(v, &mut i, |u| u == 48, c)?;
        }
    } else if v.get(i) == Some(&46) {
        i += 1;
        let start = i;
        skip(v, &mut i, |u| u == 48, c)?;
        if start == i {
            return Ok(false);
        }
    } else {
        return Ok(false);
    }
    skip(v, &mut i, space, c)?;
    Ok(i == v.len() || v.get(i) == Some(&59))
}
/// Exact ASCII grammar and ECMAScript multiline/dot terminators, without regex
/// allocation or copying potentially large script bodies.
fn has_reset(v: &[u16], c: &mut impl FnMut() -> bool) -> Result<bool, Error> {
    let mut start = 0;
    for (i, &u) in v.iter().enumerate() {
        if i.is_multiple_of(256) {
            check(c)?;
        }
        if matches!(u, 10 | 13 | 0x2028 | 0x2029) {
            if line(&v[start..i], c)? {
                return Ok(true);
            }
            start = i + 1;
        }
    }
    check(c)?;
    line(&v[start..], c)
}
impl Authoring<'_, '_> {
    pub(super) fn reset(
        &mut self,
        budget: &mut Budget,
        c: &mut impl FnMut() -> bool,
    ) -> Result<(), Error> {
        let relative = match self.source("use_relative_e_distances") {
            None | Some(Value::Bool(true)) => true,
            Some(Value::Number(v)) => *v == 1.0,
            Some(Value::String(v)) => eq(v, "1"),
            _ => false,
        };
        if !relative || !flavor(self.source("gcode_flavor")) {
            return Ok(());
        }
        let before = units(self.source("before_layer_change_gcode"));
        let change = units(self.source("layer_change_gcode"));
        if has_reset(before, c)? || has_reset(change, c)? {
            return Ok(());
        }
        self.set(
            "before_layer_change_gcode",
            Projection::Scalar(Atom::Reset(before)),
            budget,
        )?;
        self.warnings.push(Warning::RelativeExtruderReset);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_line_grammar_scan_is_cancellable_after_line_discovery() {
        let mut script = vec![32; 128 * 1024];
        script.extend("G92 E0".encode_utf16());
        let discovery_polls = script.len().div_ceil(256) + 1;
        let mut polls = 0;
        assert_eq!(
            has_reset(&script, &mut || {
                polls += 1;
                polls > discovery_polls + 2
            }),
            Err(Error::Cancelled)
        );
        assert!(has_reset(&script, &mut || false).unwrap());
    }
}
