//! Development leaf protocol. Requests bind an explicit window to the immutable
//! session source; clients cannot inject columns, substitute source or reuse a
//! prior inspection result. The project command protocol remains separate.
pub(crate) use crate::request_types::{LayerTimesBits as LayerTimes, Request, Window};
use crate::{SessionError, preview, request_types};

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

impl Request {
    pub(crate) fn parse(json: &str) -> Result<Self, SessionError> {
        if json.len() > request_types::MAX_VIEW_BYTES {
            return Err(SessionError::ResourceLimit);
        }
        let request: Self = serde_json::from_str(json).map_err(|_| SessionError::InvalidRequest)?;
        let (Self::Preview { version, .. }
        | Self::Inspection { version, .. }
        | Self::Playback { version, .. }) = &request;
        if *version as usize != request_types::VERSION {
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
