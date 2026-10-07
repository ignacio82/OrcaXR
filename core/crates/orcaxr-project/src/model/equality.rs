use orcaxr_contracts::canonical::Value;

// Structural equality has the same result as canonical equality on typed finite
// JSON. Iterator frames use depth-proportional memory, not one entry per scalar
// in a large configuration array. Shared subtrees are skipped immediately.
pub(crate) fn equal_json(a: &Value, b: &Value) -> bool {
    enum Frame<'a> {
        Array(std::iter::Zip<std::slice::Iter<'a, Value>, std::slice::Iter<'a, Value>>),
        Object(
            std::iter::Zip<
                std::collections::btree_map::Iter<'a, Vec<u16>, Value>,
                std::collections::btree_map::Iter<'a, Vec<u16>, Value>,
            >,
        ),
    }
    let mut stack = Vec::new();
    let mut current = Some((a, b));
    loop {
        if let Some((a, b)) = current.take()
            && !std::ptr::eq(a, b)
        {
            match (a, b) {
                (Value::Null, Value::Null) => {}
                (Value::Bool(a), Value::Bool(b)) if a == b => {}
                (Value::Number(a), Value::Number(b)) if a == b => {}
                (Value::String(a), Value::String(b)) if a == b => {}
                (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
                    stack.push(Frame::Array(a.iter().zip(b)))
                }
                (Value::Object(a), Value::Object(b)) if a.len() == b.len() => {
                    stack.push(Frame::Object(a.iter().zip(b)))
                }
                _ => return false,
            }
        }
        while let Some(frame) = stack.last_mut() {
            current = match frame {
                Frame::Array(iter) => iter.next(),
                Frame::Object(iter) => match iter.next() {
                    Some(((ak, av), (bk, bv))) => {
                        if ak != bk {
                            return false;
                        }
                        Some((av, bv))
                    }
                    None => None,
                },
            };
            if current.is_some() {
                break;
            }
            stack.pop();
        }
        if current.is_none() {
            return true;
        }
    }
}
