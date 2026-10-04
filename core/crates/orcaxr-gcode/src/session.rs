use crate::{
    Cancellation, Index, Limits, Options, ParseError, index_with_cancellation, layout, pack,
    packet, parse_window_with_cancellation, parse_with_cancellation,
};
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionError {
    InvalidOptions,
    InvalidState,
    InvalidRange,
    SourceLength,
    ResourceLimit,
    Cancelled,
}
impl SessionError {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidOptions => "invalid_options",
            Self::InvalidState => "invalid_state",
            Self::InvalidRange => "invalid_range",
            Self::SourceLength => "source_length",
            Self::ResourceLimit => "resource_limit",
            Self::Cancelled => "cancelled",
        }
    }
}
impl From<ParseError> for SessionError {
    fn from(error: ParseError) -> Self {
        match error {
            ParseError::Cancelled => Self::Cancelled,
            ParseError::InvalidWindow => Self::InvalidRange,
            ParseError::InvalidLimits | ParseError::InvalidFilaments => Self::InvalidOptions,
        }
    }
}

enum State {
    Receiving(Vec<u16>),
    Indexed(Index),
    Failed,
}
/// One immutable source and index. A parsed window is returned to the host;
/// the session does not retain previous windows or packed transfer buffers.
pub struct Session {
    state: State,
    expected: usize,
    options: Options,
    cancellation: Cancellation,
}
impl Session {
    pub fn new(
        expected: usize,
        options: &str,
        cancellation: Cancellation,
    ) -> Result<Self, SessionError> {
        if expected > Limits::default().input_characters || options.len() > 64 * 1024 {
            return Err(SessionError::ResourceLimit);
        }
        let value: serde_json::Value =
            serde_json::from_str(options).map_err(|_| SessionError::InvalidOptions)?;
        if !value.is_object() || value.get("limits").is_some_and(|v| !v.is_object()) {
            return Err(SessionError::InvalidOptions);
        }
        let mut options: Options =
            serde_json::from_value(value).map_err(|_| SessionError::InvalidOptions)?;
        let limit = options
            .limits
            .resolve()?
            .records
            .min(layout::MAX_WINDOW_RECORDS);
        options.limits.records = Some(limit as f64);
        parse_with_cancellation(&[], &options, &cancellation)?;
        let mut source = Vec::new();
        source
            .try_reserve_exact(expected)
            .map_err(|_| SessionError::ResourceLimit)?;
        Ok(Self {
            state: State::Receiving(source),
            expected,
            options,
            cancellation,
        })
    }
    fn active(&self) -> Result<(), SessionError> {
        if self.cancellation.is_cancelled() {
            Err(SessionError::Cancelled)
        } else {
            Ok(())
        }
    }
    /// Offset makes retries and out-of-order delivery explicit; errors do not
    /// consume a chunk. No Rust string conversion can replace lone surrogates.
    pub fn append(&mut self, offset: usize, chunk: &[u16]) -> Result<(), SessionError> {
        self.active()?;
        let State::Receiving(source) = &mut self.state else {
            return Err(SessionError::InvalidState);
        };
        if offset != source.len()
            || chunk.len() > layout::MAX_CHUNK_UNITS
            || chunk.len() > self.expected - source.len()
        {
            return Err(SessionError::SourceLength);
        }
        source.extend_from_slice(chunk);
        Ok(())
    }
    pub fn seal(&mut self) -> Result<String, SessionError> {
        self.active()?;
        let State::Receiving(source) = &self.state else {
            return Err(SessionError::InvalidState);
        };
        if source.len() != self.expected {
            return Err(SessionError::SourceLength);
        }
        let State::Receiving(source) = std::mem::replace(&mut self.state, State::Failed) else {
            unreachable!();
        };
        let index = index_with_cancellation(source.into(), &self.options, &self.cancellation)?;
        self.state = State::Indexed(index);
        self.info()
    }
    fn index(&self) -> Result<&Index, SessionError> {
        self.active()?;
        match &self.state {
            State::Indexed(index) => Ok(index),
            _ => Err(SessionError::InvalidState),
        }
    }
    pub fn info(&self) -> Result<String, SessionError> {
        let index = self.index()?;
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Info<'a> {
            version: usize,
            entry_count: usize,
            layer_count: u32,
            record_count: usize,
            path_point_count: u64,
            source_length: usize,
            complete: bool,
            warnings: &'a [crate::Warning],
            limits: Limits,
            #[serde(skip_serializing_if = "Option::is_none")]
            termination_reason: Option<crate::Termination>,
        }
        let value = packet::json(&Info {
            version: layout::VERSION,
            entry_count: index.entries.len(),
            layer_count: index.layer_count,
            record_count: index.record_count,
            path_point_count: index.path_point_count,
            source_length: index.source_length,
            complete: index.complete,
            warnings: &index.warnings,
            limits: index.limits,
            termination_reason: index.termination_reason,
        })?;
        String::from_utf8(value).map_err(|_| SessionError::InvalidState)
    }
    pub fn page(&self, start: usize, count: usize) -> Result<String, SessionError> {
        let index = self.index()?;
        if count > layout::MAX_INDEX_PAGE_ENTRIES || start > index.entries.len() {
            return Err(SessionError::InvalidRange);
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Entry {
            layer: u32,
            start_offset: usize,
            end_offset_exclusive: usize,
            records_before: usize,
            path_points_before: u64,
        }
        let entries: Vec<_> = index
            .entries
            .iter()
            .skip(start)
            .take(count)
            .map(|v| Entry {
                layer: v.layer,
                start_offset: v.start_offset,
                end_offset_exclusive: v.end_offset_exclusive,
                records_before: v.records_before,
                path_points_before: v.path_points_before,
            })
            .collect();
        String::from_utf8(packet::json(&entries)?).map_err(|_| SessionError::InvalidState)
    }
    pub fn window(&self, first: usize, last: usize) -> Result<Vec<u8>, SessionError> {
        let index = self.index()?;
        if first > last || last >= index.entries.len() {
            return Err(SessionError::InvalidRange);
        }
        // Rejected/cancelled parses publish no packet. Whole arcs remain atomic.
        let model = parse_window_with_cancellation(
            index,
            first as isize,
            last as isize,
            &self.options,
            &self.cancellation,
        )?;
        let result = pack(&model)?;
        self.active()?;
        Ok(result)
    }
    pub fn whole(&self) -> Result<Vec<u8>, SessionError> {
        let index = self.index()?;
        let model = parse_with_cancellation(&index.source, &self.options, &self.cancellation)?;
        let result = pack(&model)?;
        self.active()?;
        Ok(result)
    }
}
