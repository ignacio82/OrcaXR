use serde::{Deserialize, Serialize};

/// Text at the JavaScript/Java boundary is UTF-16, including lone surrogates.
/// Serialize as code units; host adapters reconstruct strings without loss.
#[derive(Debug, Default, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Text(pub Vec<u16>);

impl Text {
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn equals(&self, other: &str) -> bool {
        self.0.iter().copied().eq(other.encode_utf16())
    }
    pub fn utf8(&self) -> Option<String> {
        String::from_utf16(&self.0).ok()
    }
    pub fn surround(prefix: &str, value: &Self, suffix: &str) -> Self {
        Self(
            prefix
                .encode_utf16()
                .chain(value.0.iter().copied())
                .chain(suffix.encode_utf16())
                .collect(),
        )
    }
}
impl From<&str> for Text {
    fn from(value: &str) -> Self {
        Self(value.encode_utf16().collect())
    }
}
impl From<String> for Text {
    fn from(value: String) -> Self {
        Self::from(value.as_str())
    }
}
