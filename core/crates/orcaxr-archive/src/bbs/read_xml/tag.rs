use super::{Error, Event, Failure, Scanner, Tag, charge, text};
use std::ops::Range;
#[derive(Debug)]
pub(super) struct AttributeRecord {
    pub name: Range<usize>,
    pub value: Range<usize>,
    pub decoded: Option<String>,
}
pub(super) struct Frame {
    pub name: String,
    pub namespaces: Vec<String>,
}
fn name(value: &str) -> Result<(), Failure> {
    let mut parts = 0;
    for part in value.split(':') {
        parts += 1;
        let mut bytes = part.bytes();
        let Some(first) = bytes.next() else {
            return Err(Failure::Syntax);
        };
        if !(first.is_ascii_alphabetic() || first == b'_')
            || bytes.any(|b| !(b.is_ascii_alphanumeric() || b == b'_' || b == b'.' || b == b'-'))
        {
            return Err(Failure::Syntax);
        }
    }
    if parts > 2 {
        return Err(Failure::Syntax);
    }
    Ok(())
}
fn skip_space(raw: &str, cursor: &mut usize) {
    while let Some(c) = raw[*cursor..].chars().next() {
        if !text::whitespace(c) {
            break;
        }
        *cursor += c.len_utf8();
    }
}
fn expanded_attribute<'a>(
    name: &'a str,
    namespaces: &'a std::collections::BTreeMap<String, Vec<String>>,
) -> (Option<&'a str>, &'a str) {
    const XMLNS: &str = "http://www.w3.org/2000/xmlns/";
    if name == "xmlns" {
        return (Some(XMLNS), "xmlns");
    }
    if let Some(local) = name.strip_prefix("xmlns:") {
        return (Some(XMLNS), local);
    }
    if let Some((prefix, local)) = name.split_once(':') {
        return (
            namespaces
                .get(prefix)
                .and_then(|v| v.last().map(String::as_str)),
            local,
        );
    }
    (None, name)
}
impl<'a> Tag<'a> {
    pub fn local_name(self) -> &'a str {
        self.name
            .split_once(':')
            .map_or(self.name, |(_, local)| local)
    }
    /// Resolve the element's namespace. Unlike attributes, unprefixed elements
    /// inherit the default namespace.
    pub fn namespace(self) -> Option<&'a str> {
        let prefix = self.name.split_once(':').map_or("", |(prefix, _)| prefix);
        self.namespaces
            .get(prefix)
            .and_then(|values| values.last().map(String::as_str))
    }
    pub fn attributes(self) -> impl ExactSizeIterator<Item = super::Attribute<'a>> {
        self.attributes.iter().map(move |attribute| {
            let name = &self.raw[attribute.name.clone()];
            let (namespace, local_name) = expanded_attribute(name, self.namespaces);
            super::Attribute {
                name,
                local_name,
                namespace,
                value: attribute
                    .decoded
                    .as_deref()
                    .unwrap_or(&self.raw[attribute.value.clone()]),
            }
        })
    }
}
impl<V, C, E> Scanner<V, C, E>
where
    V: FnMut(Event<'_>) -> Result<(), E>,
    C: FnMut() -> bool,
{
    pub(super) fn finish_tag(&mut self) -> Result<(), Error<E>> {
        if self.buffer.len() > self.limits.token_bytes {
            return Err(Failure::ResourceLimit.into());
        }
        let raw = std::mem::take(&mut self.buffer);
        let result = self.parse_tag(&raw);
        self.buffer = raw;
        result
    }
    fn bound(&self, name: &str) -> Result<(), Failure> {
        if let Some((prefix, _)) = name.split_once(':')
            && (prefix == "xmlns" || !self.namespaces.contains_key(prefix))
        {
            return Err(Failure::Namespace);
        }
        Ok(())
    }
    fn namespace_binding(prefix: &str, uri: &str) -> Result<(), Failure> {
        const XML: &str = "http://www.w3.org/XML/1998/namespace";
        const XMLNS: &str = "http://www.w3.org/2000/xmlns/";
        if prefix == "xmlns"
            || uri == XMLNS
            || (prefix == "xml" && uri != XML)
            || (prefix != "xml" && uri == XML)
            || (!prefix.is_empty() && uri.is_empty())
        {
            return Err(Failure::Namespace);
        }
        Ok(())
    }
    fn pop_namespaces(&mut self, prefixes: Vec<String>) {
        for prefix in prefixes {
            let values = self.namespaces.get_mut(&prefix).unwrap();
            values.pop();
            if values.is_empty() {
                self.namespaces.remove(&prefix);
            }
        }
    }
    fn parse_tag(&mut self, raw: &str) -> Result<(), Error<E>> {
        self.check()?;
        let source = &raw[1..raw.len() - 1];
        if let Some(closing) = source.strip_prefix('/') {
            let closing = closing.trim_matches(text::whitespace);
            name(closing)?;
            let frame = self.stack.pop().ok_or(Failure::Syntax)?;
            if frame.name != closing {
                return Err(Failure::Syntax.into());
            }
            self.emit(Event::Close { raw, name: closing })?;
            self.pop_namespaces(frame.namespaces);
            return Ok(());
        }
        charge(&mut self.receipt.elements, 1, self.limits.elements)?;
        let depth = self
            .stack
            .len()
            .checked_add(1)
            .filter(|d| *d <= self.limits.depth)
            .ok_or(Failure::ResourceLimit)?;
        self.receipt.max_depth = self.receipt.max_depth.max(depth);
        let mut cursor = 1;
        let end = raw.len() - 1;
        skip_space(raw, &mut cursor);
        let name_start = cursor;
        while cursor < end {
            let c = raw[cursor..].chars().next().unwrap();
            if text::whitespace(c) || c == '/' {
                break;
            }
            cursor += c.len_utf8();
        }
        let tag_name = &raw[name_start..cursor];
        name(tag_name)?;
        self.attributes.clear();
        self.attribute_order.clear();
        self.expanded_order.clear();
        let mut self_closing = false;
        while cursor < end {
            skip_space(raw, &mut cursor);
            if cursor >= end {
                break;
            }
            if raw.as_bytes()[cursor] == b'/' {
                cursor += 1;
                skip_space(raw, &mut cursor);
                if cursor != end {
                    return Err(Failure::Syntax.into());
                }
                self_closing = true;
                break;
            }
            charge(&mut self.receipt.attributes, 1, self.limits.attributes)?;
            let start = cursor;
            while cursor < end {
                let c = raw[cursor..].chars().next().unwrap();
                if text::whitespace(c) || c == '=' {
                    break;
                }
                cursor += c.len_utf8();
            }
            let attribute_name = start..cursor;
            name(&raw[attribute_name.clone()])?;
            skip_space(raw, &mut cursor);
            if raw.as_bytes().get(cursor) != Some(&b'=') {
                return Err(Failure::Syntax.into());
            }
            cursor += 1;
            skip_space(raw, &mut cursor);
            let quote = *raw.as_bytes().get(cursor).ok_or(Failure::Syntax)?;
            if quote != b'\'' && quote != b'"' {
                return Err(Failure::Syntax.into());
            }
            cursor += 1;
            let start = cursor;
            while cursor < end && raw.as_bytes()[cursor] != quote {
                cursor += 1;
            }
            if cursor >= end {
                return Err(Failure::Syntax.into());
            }
            let value = start..cursor;
            let decoded = text::decode(&raw[value.clone()], self.limits.token_bytes)?;
            cursor += 1;
            self.attributes.push(AttributeRecord {
                name: attribute_name,
                value,
                decoded,
            });
        }
        self.attribute_order.extend(0..self.attributes.len());
        self.attribute_order.sort_unstable_by(|&a, &b| {
            raw[self.attributes[a].name.clone()].cmp(&raw[self.attributes[b].name.clone()])
        });
        for pair in self.attribute_order.windows(2) {
            if raw[self.attributes[pair[0]].name.clone()]
                == raw[self.attributes[pair[1]].name.clone()]
            {
                return Err(Failure::Syntax.into());
            }
        }
        let mut prefixes = vec![];
        for attribute in &self.attributes {
            let name = &raw[attribute.name.clone()];
            let value = attribute
                .decoded
                .as_deref()
                .unwrap_or(&raw[attribute.value.clone()]);
            let prefix = if name == "xmlns" {
                Some("")
            } else {
                name.strip_prefix("xmlns:")
            };
            if let Some(prefix) = prefix {
                Self::namespace_binding(prefix, value)?;
                self.namespaces
                    .entry(prefix.into())
                    .or_default()
                    .push(value.into());
                prefixes.push(prefix.into());
            }
        }
        self.bound(tag_name)?;
        for attribute in &self.attributes {
            let name = &raw[attribute.name.clone()];
            if name != "xmlns" && !name.starts_with("xmlns:") {
                self.bound(name)?;
            }
        }
        self.expanded_order.extend(0..self.attributes.len());
        self.expanded_order.sort_unstable_by(|&a, &b| {
            expanded_attribute(&raw[self.attributes[a].name.clone()], &self.namespaces).cmp(
                &expanded_attribute(&raw[self.attributes[b].name.clone()], &self.namespaces),
            )
        });
        for pair in self.expanded_order.windows(2) {
            let a = expanded_attribute(
                &raw[self.attributes[pair[0]].name.clone()],
                &self.namespaces,
            );
            let b = expanded_attribute(
                &raw[self.attributes[pair[1]].name.clone()],
                &self.namespaces,
            );
            if a == b {
                return Err(Failure::Namespace.into());
            }
        }
        if self.stack.is_empty() {
            self.root_count += 1;
            if self.root_count > 1 {
                return Err(Failure::Syntax.into());
            }
        }
        let tag = Tag {
            raw,
            name: tag_name,
            self_closing,
            attributes: &self.attributes,
            namespaces: &self.namespaces,
        };
        (self.visit)(Event::Open(tag)).map_err(Error::Visitor)?;
        if self_closing {
            self.pop_namespaces(prefixes);
        } else {
            self.stack.push(Frame {
                name: tag_name.into(),
                namespaces: prefixes,
            });
        }
        Ok(())
    }
}
