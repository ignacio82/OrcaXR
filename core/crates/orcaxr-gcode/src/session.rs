use crate::{
    Cancellation, Index, Limits, Model, Options, ParseError, Text,
    document::{Document, DocumentError, WindowLimits},
    index_with_cancellation, inspection, layout, packet, parse_window_with_cancellation,
    parse_with_cancellation, preview, view_packet,
    view_request::{Request, Window},
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
    InvalidRequest,
    UnsupportedProtocol,
    Computation(&'static str),
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
            Self::InvalidRequest => "invalid_request",
            Self::UnsupportedProtocol => "unsupported_protocol",
            Self::Computation(code) => code,
        }
    }
}
impl From<DocumentError> for SessionError {
    fn from(error: DocumentError) -> Self {
        match error {
            DocumentError::Cancelled => Self::Cancelled,
            DocumentError::ResourceLimit => Self::ResourceLimit,
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
/// One immutable source/index and at most one parsed window. Old columns are
/// released before parsing a different selector; packed transfers are not kept.
pub struct Session {
    state: State,
    expected: usize,
    options: Options,
    cancellation: Cancellation,
    loaded: Option<(Window, Model)>,
    /// Readable-text line index, built on first use over the sealed source.
    document: Option<Document>,
}
impl Session {
    pub fn new(
        expected: usize,
        options: &str,
        cancellation: Cancellation,
    ) -> Result<Self, SessionError> {
        if expected > Limits::default().input_characters
            || options.len() > crate::request_types::MAX_OPTIONS_BYTES
        {
            return Err(SessionError::ResourceLimit);
        }
        let mut options: Options =
            serde_json::from_str(options).map_err(|_| SessionError::InvalidOptions)?;
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
            loaded: None,
            document: None,
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
    /// What the sealed artifact states about itself and the preview panel's
    /// wording of it (`summarizeGcodeArtifact`, `describeArtifactSummary`), as
    /// JSON `{summary, text}` in the browser's field names.
    pub fn summary(&self) -> Result<String, SessionError> {
        let index = self.index()?;
        let summary = crate::artifact::summarize_text(&index.source);
        #[derive(Serialize)]
        struct Summary<'a> {
            summary: &'a crate::artifact::ArtifactSummary,
            text: crate::artifact::SummaryText,
        }
        let value = packet::json_with_cancellation(
            &Summary {
                text: crate::artifact::describe(&summary),
                summary: &summary,
            },
            Some(&self.cancellation),
        )?;
        String::from_utf8(value).map_err(|_| SessionError::InvalidState)
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
        let value = packet::json_with_cancellation(
            &Info {
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
            },
            Some(&self.cancellation),
        )?;
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
        String::from_utf8(packet::json_with_cancellation(
            &entries,
            Some(&self.cancellation),
        )?)
        .map_err(|_| SessionError::InvalidState)
    }
    fn load(&mut self, window: Window) -> Result<(), SessionError> {
        let index = self.index()?;
        if let Window::Entries(first, last) = window
            && (first > last || last >= index.entries.len())
        {
            return Err(SessionError::InvalidRange);
        }
        if self
            .loaded
            .as_ref()
            .is_some_and(|(selected, _)| *selected == window)
        {
            return Ok(());
        }
        self.loaded = None;
        let index = self.index()?;
        let model = match window {
            Window::Whole => {
                parse_with_cancellation(&index.source, &self.options, &self.cancellation)?
            }
            Window::Entries(first, last) => parse_window_with_cancellation(
                index,
                first as isize,
                last as isize,
                &self.options,
                &self.cancellation,
            )?,
        };
        self.active()?;
        self.loaded = Some((window, model));
        Ok(())
    }
    fn packed(&mut self, window: Window) -> Result<Vec<u8>, SessionError> {
        self.load(window)?;
        let result = packet::pack_with_cancellation(
            &self.loaded.as_ref().ok_or(SessionError::InvalidState)?.1,
            &self.cancellation,
        )?;
        self.active()?;
        Ok(result)
    }
    pub fn window(&mut self, first: usize, last: usize) -> Result<Vec<u8>, SessionError> {
        self.packed(Window::Entries(first, last))
    }
    pub fn whole(&mut self) -> Result<Vec<u8>, SessionError> {
        self.packed(Window::Whole)
    }
    pub fn view(&mut self, json: &str) -> Result<Vec<u8>, SessionError> {
        self.active()?;
        let request = Request::parse(json)?;
        self.load(request.window())?;
        let model = &self.loaded.as_ref().ok_or(SessionError::InvalidState)?.1;
        let cancel = &self.cancellation;
        match request {
            Request::Preview { request, .. } => {
                let projection = preview::project(
                    model,
                    &request.map_layer_times(crate::view_request::LayerTimes::decode),
                    cancel,
                )
                .map_err(|e| SessionError::Computation(e.code))?;
                view_packet::preview(&projection, cancel)
            }
            Request::Inspection {
                request,
                include_source,
                ..
            } => {
                let state = inspection::inspect(
                    model,
                    &request,
                    if include_source {
                        Some(&self.index()?.source)
                    } else {
                        None
                    },
                    cancel,
                )
                .map_err(|e| SessionError::Computation(e.code))?;
                view_packet::inspection(&state, cancel)
            }
            Request::Playback {
                request,
                playback,
                include_source,
                ..
            } => {
                let state = inspection::inspect(
                    model,
                    &request,
                    if include_source {
                        Some(&self.index()?.source)
                    } else {
                        None
                    },
                    cancel,
                )
                .map_err(|e| SessionError::Computation(e.code))?;
                let frames = inspection::playback(&state, &playback, cancel)
                    .map_err(|e| SessionError::Computation(e.code))?;
                view_packet::playback(&frames, cancel)
            }
        }
    }

    fn text(&mut self) -> Result<&Document, SessionError> {
        self.active()?;
        if self.document.is_none() {
            let source = self.index()?.source.clone();
            self.document = Some(Document::new(source, &self.cancellation)?);
        }
        Ok(self.document.as_ref().expect("built document"))
    }
    /// Readable lines `[from, from + count)` with the browser viewer's clamping.
    /// Text is UTF-16 code units, so lone surrogates survive the transport.
    pub fn text_window(&mut self, from: f64, count: f64) -> Result<String, SessionError> {
        #[derive(Serialize)]
        struct Line {
            number: usize,
            text: Text,
        }
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct TextWindow {
            line_count: usize,
            lines: Vec<Line>,
        }
        let document = self.text()?;
        let lines = document
            .window(
                from,
                count,
                WindowLimits {
                    lines: layout::MAX_TEXT_WINDOW_LINES,
                    units: layout::MAX_TEXT_WINDOW_UNITS,
                },
            )?
            .into_iter()
            .map(|line| Line {
                number: line.number,
                text: Text(line.text.to_vec()),
            })
            .collect();
        let value = TextWindow {
            line_count: document.line_count(),
            lines,
        };
        String::from_utf8(packet::json_with_cancellation(
            &value,
            Some(&self.cancellation),
        )?)
        .map_err(|_| SessionError::InvalidState)
    }
    /// Line numbers containing `query` case-insensitively, at most `limit`.
    pub fn text_search(&mut self, query: &[u16], limit: usize) -> Result<String, SessionError> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct TextSearch {
            line_numbers: Vec<usize>,
            truncated: bool,
        }
        let cancellation = self.cancellation.clone();
        let result = self.text()?.search(query, limit, &cancellation)?;
        let value = TextSearch {
            line_numbers: result.line_numbers,
            truncated: result.truncated,
        };
        String::from_utf8(packet::json_with_cancellation(&value, Some(&cancellation))?)
            .map_err(|_| SessionError::InvalidState)
    }
}
