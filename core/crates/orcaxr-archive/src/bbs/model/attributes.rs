use super::*;
pub(super) const OBJECT: &str = "https://orcaxr.martinez.fyi/3mf/project/1/core-object-attributes";
pub(super) const COMPONENT: &str =
    "https://orcaxr.martinez.fyi/3mf/project/1/core-component-attributes";
pub(super) const BUILD: &str = "https://orcaxr.martinez.fyi/3mf/project/1/core-build-attributes";
const FACET: &str = "https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes";
#[derive(Clone, Copy)]
pub(super) struct Attribute<'a> {
    pub namespace: &'a [u16],
    pub name: &'a [u16],
    pub value: &'a [u16],
}
pub(super) type Attributes<'a> = Vec<Attribute<'a>>;
pub(super) type Facets<'a> = Vec<(u64, Attributes<'a>)>;
#[derive(Default)]
pub(super) struct Namespaces<'a>(Vec<&'a [u16]>);
impl<'a> Namespaces<'a> {
    fn add(&mut self, ns: &'a [u16]) {
        if !ns.is_empty() && !eq(ns, NS) {
            self.0.push(ns);
        }
    }
    pub fn finish(&mut self) {
        self.0.sort_unstable();
        self.0.dedup();
    }
    pub fn iter(&self) -> impl Iterator<Item = (usize, &'a [u16])> + '_ {
        self.0.iter().copied().enumerate().map(|(i, v)| (i + 1, v))
    }
    pub fn name<'b>(&self, attr: &Attribute<'b>) -> Name<'b> {
        Name {
            local: attr.name,
            prefix: if attr.namespace.is_empty() {
                0
            } else if eq(attr.namespace, NS) {
                1
            } else {
                self.0
                    .binary_search(&attr.namespace)
                    .expect("collected namespace")
                    + 2
            },
        }
    }
}
#[derive(Clone, Copy)]
pub(super) struct Name<'a> {
    pub local: &'a [u16],
    pub prefix: usize,
}
impl Name<'_> {
    fn prefix_units(self) -> ([u16; 32], usize) {
        let mut out = [0; 32];
        if self.prefix == 0 {
            return (out, 0);
        }
        if self.prefix == 1 {
            out[..3].copy_from_slice(&[111, 120, 58]);
            return (out, 3);
        }
        out[..3].copy_from_slice(&[101, 120, 116]);
        let mut n = self.prefix - 1;
        let mut digits = [0; 20];
        let mut len = 0;
        loop {
            digits[len] = (n % 10) as u16 + 48;
            len += 1;
            n /= 10;
            if n == 0 {
                break;
            }
        }
        for i in 0..len {
            out[3 + i] = digits[len - i - 1];
        }
        out[3 + len] = 58;
        (out, 4 + len)
    }
    pub fn compare(self, other: Self) -> std::cmp::Ordering {
        let (a, an) = self.prefix_units();
        let (b, bn) = other.prefix_units();
        a[..an]
            .iter()
            .chain(self.local)
            .cmp(b[..bn].iter().chain(other.local))
    }
    pub fn write<W: std::io::Write, C: FnMut() -> bool>(
        self,
        w: &mut xml::Writer<'_, W, C>,
    ) -> Result<(), Error> {
        let (prefix, len) = self.prefix_units();
        w.attribute(&prefix[..len])?;
        w.attribute(self.local)?;
        Ok(())
    }
}
fn decode<'a>(
    raw: Option<&'a Value>,
    namespaces: &mut Namespaces<'a>,
    budget: &mut Budget,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Attributes<'a>, Error> {
    let mut result = Vec::new();
    for value in array(raw)? {
        check(cancelled)?;
        budget.record()?;
        let namespace = text(field(value, "namespace"))?;
        let name = text(field(value, "name"))?;
        let value = text(field(value, "value"))?;
        budget.text(namespace)?;
        budget.text(name)?;
        budget.text(value)?;
        let start = |v: u16| matches!(v,65..=90|97..=122|95);
        if !name.first().is_some_and(|&v| start(v))
            || !name
                .iter()
                .skip(1)
                .all(|&v| start(v) || matches!(v, 48..=57 | 46 | 45))
        {
            return Err(Error::Attribute);
        }
        namespaces.add(namespace);
        result.push(Attribute {
            namespace,
            name,
            value,
        });
    }
    Ok(result)
}
pub(super) fn read<'a>(
    extension: Option<&'a JsonObject>,
    key: &str,
    namespaces: &mut Namespaces<'a>,
    budget: &mut Budget,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Attributes<'a>, Error> {
    decode(
        extension.and_then(|v| field(v.value(), key)),
        namespaces,
        budget,
        cancelled,
    )
}
pub(super) fn facets<'a>(
    extension: Option<&'a JsonObject>,
    triangle_count: f64,
    namespaces: &mut Namespaces<'a>,
    budget: &mut Budget,
    cancelled: &mut impl FnMut() -> bool,
) -> Result<Facets<'a>, Error> {
    let mut rows = Vec::new();
    for row in array(extension.and_then(|v| field(v.value(), FACET)))? {
        check(cancelled)?;
        budget.record()?;
        let Some(Value::Number(n)) = field(row, "triangle") else {
            return Err(Error::FacetIndex);
        };
        if n.fract() != 0.0 || *n < 0.0 || *n >= triangle_count || *n > 9_007_199_254_740_991.0 {
            return Err(Error::FacetIndex);
        }
        rows.push((
            *n as u64,
            decode(field(row, "attributes"), namespaces, budget, cancelled)?,
        ));
    }
    // Stable sorting retains the last-wins order for repeated source facets.
    rows.sort_by_key(|row| row.0);
    Ok(rows)
}
pub(super) fn included(attribute: &Attribute<'_>, reserved: &[&str], facet: bool) -> bool {
    !(attribute.namespace.is_empty() && reserved.iter().any(|s| eq(attribute.name, s))
        || !facet
            && eq(attribute.namespace, NS)
            && (eq(attribute.name, "stable-id") || eq(attribute.name, "instance-id")))
}
pub(super) fn validate_value(
    value: &[u16],
    cancelled: &mut impl FnMut() -> bool,
) -> Result<(), Error> {
    for (i, c) in char::decode_utf16(value.iter().copied()).enumerate() {
        if i.is_multiple_of(256) {
            check(cancelled)?;
        }
        let c = c.map_err(|_| Error::Xml(xml::Error::XmlCharacter))?;
        if !xml::valid_character(c) {
            return Err(Error::Xml(xml::Error::XmlCharacter));
        }
    }
    Ok(())
}
