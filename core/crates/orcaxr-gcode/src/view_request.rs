//! Development leaf protocol. Requests bind an explicit window to the immutable
//! session source; clients cannot inject columns, substitute source or reuse a
//! prior inspection result. The project command protocol remains separate.
use crate::{SessionError, Text, inspection, preview, view_layout};
use serde::Deserialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(try_from = "Vec<usize>")]
pub(crate) enum Window {
    Whole,
    Entries(usize, usize),
}
impl TryFrom<Vec<usize>> for Window {
    type Error = &'static str;
    fn try_from(value: Vec<usize>) -> Result<Self, Self::Error> {
        match value.as_slice() {
            [] => Ok(Self::Whole),
            [first, last] if first <= last && *last <= u32::MAX as usize => {
                Ok(Self::Entries(*first, *last))
            }
            _ => Err("invalid window"),
        }
    }
}

/// Bits preserve all Float32 inputs, including NaN/Infinity that must produce an
/// explicit unsupported projection rather than silently become JSON null/zero.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LayerTimes {
    seconds_by_layer_bits: Vec<u32>,
    provenance: Text,
}
impl LayerTimes {
    pub(crate) fn decode(self) -> preview::LayerTimes {
        preview::LayerTimes {
            seconds_by_layer: self
                .seconds_by_layer_bits
                .into_iter()
                .map(f32::from_bits)
                .collect(),
            provenance: self.provenance,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum Request {
    Preview {
        version: u32,
        window: Window,
        request: preview::PreviewRequest<LayerTimes>,
    },
    Inspection {
        version: u32,
        window: Window,
        request: inspection::InspectionRequest,
        #[serde(default)]
        include_source: bool,
    },
    Playback {
        version: u32,
        window: Window,
        request: inspection::InspectionRequest,
        playback: inspection::PlaybackOptions,
        #[serde(default)]
        include_source: bool,
    },
}
impl Request {
    pub(crate) fn parse(json: &str) -> Result<Self, SessionError> {
        if json.len() > view_layout::MAX_REQUEST_BYTES {
            return Err(SessionError::ResourceLimit);
        }
        let request: Self = serde_json::from_str(json).map_err(|_| SessionError::InvalidRequest)?;
        let (Self::Preview { version, .. }
        | Self::Inspection { version, .. }
        | Self::Playback { version, .. }) = &request;
        if *version as usize != view_layout::VERSION {
            return Err(SessionError::UnsupportedProtocol);
        }
        Ok(request)
    }
    pub(crate) fn window(&self) -> Window {
        match self {
            Self::Preview { window, .. }
            | Self::Inspection { window, .. }
            | Self::Playback { window, .. } => *window,
        }
    }
}
