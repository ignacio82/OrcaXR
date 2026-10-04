use crate::{
    Cancellation, Text, arc, f, finite_f32,
    lexer::{self, Command},
    model::*,
    number,
};
use std::{collections::HashMap, f64::consts::PI, sync::Arc};

const COLORS: [&str; 6] = [
    "#0B2C7A", "#1C8891", "#AAF200", "#F5CE0A", "#D16830", "#942616",
];

pub fn parse(source: &[u16], options: &Options) -> Result<Model, ParseError> {
    parse_with_cancellation(source, options, &Cancellation::default())
}
pub fn parse_with_cancellation(
    source: &[u16],
    options: &Options,
    cancellation: &Cancellation,
) -> Result<Model, ParseError> {
    let mut parser = Parser::new(source, options, true, None, cancellation)?;
    parser.run()?;
    Ok(parser.finish())
}

pub fn index(source: Arc<[u16]>, options: &Options) -> Result<Index, ParseError> {
    index_with_cancellation(source, options, &Cancellation::default())
}
pub fn index_with_cancellation(
    source: Arc<[u16]>,
    options: &Options,
    cancellation: &Cancellation,
) -> Result<Index, ParseError> {
    let mut parser = Parser::new(&source, options, false, None, cancellation)?;
    parser.run()?;
    let mut boundaries = std::mem::take(&mut parser.boundaries);
    let end = parser.stopped_at.unwrap_or(parser.parsed_characters);
    let mut entries = vec![IndexEntry {
        layer: 0,
        start_offset: 0,
        end_offset_exclusive: boundaries.first().map_or(end, |entry| entry.start_offset),
        records_before: 0,
        path_points_before: 0,
        checkpoint: parser.initial.clone(),
    }];
    for position in 0..boundaries.len() {
        boundaries[position].end_offset_exclusive = boundaries
            .get(position + 1)
            .map_or(end, |next| next.start_offset);
    }
    entries.extend(boundaries);
    let path_point_count = parser.total_points;
    let model = parser.finish();
    Ok(Index {
        entries,
        layer_count: model.layer_count,
        record_count: model.columns.count,
        path_point_count,
        source_length: model.source_length,
        warnings: model.warnings,
        complete: model.complete,
        termination_reason: model.termination_reason,
        limits: model.limits,
        source,
    })
}

pub fn parse_window(
    index: &Index,
    first: isize,
    last: isize,
    options: &Options,
) -> Result<Model, ParseError> {
    parse_window_with_cancellation(index, first, last, options, &Cancellation::default())
}
pub fn parse_window_with_cancellation(
    index: &Index,
    first: isize,
    last: isize,
    options: &Options,
    cancellation: &Cancellation,
) -> Result<Model, ParseError> {
    if index.entries.is_empty() {
        return Err(ParseError::InvalidWindow);
    }
    let bound = |value: isize| value.max(0).min(index.entries.len() as isize - 1) as usize;
    let (first, last) = (bound(first), bound(last));
    if last < first {
        return Err(ParseError::InvalidWindow);
    }
    let from = &index.entries[first];
    let mut parser = Parser::new(
        &index.source,
        options,
        true,
        Some((
            from.start_offset,
            index.entries[last].end_offset_exclusive,
            &from.checkpoint,
        )),
        cancellation,
    )?;
    parser.run()?;
    let mut model = parser.finish();
    if !index.complete {
        model.complete = false;
        model.termination_reason = model.termination_reason.or(index.termination_reason);
    }
    Ok(model)
}

struct Parser<'a> {
    cancellation: &'a Cancellation,
    cancelled: bool,
    source: &'a [u16],
    options: &'a Options,
    limits: Limits,
    state: Checkpoint,
    initial: Checkpoint,
    role_indices: HashMap<Text, u16>,
    columns: Columns,
    points: PathPoints,
    total_points: u64,
    retain: bool,
    range: Option<(usize, usize)>,
    warnings: Vec<Warning>,
    warnings_suppressed: bool,
    termination: Option<Termination>,
    parsed_lines: usize,
    parsed_characters: usize,
    boundaries: Vec<IndexEntry>,
    checkpoint_bytes: usize,
    records_at_checkpoint: usize,
    points_at_checkpoint: u64,
    stopped_at: Option<usize>,
}

impl<'a> Parser<'a> {
    fn new(
        source: &'a [u16],
        options: &'a Options,
        retain: bool,
        range: Option<(usize, usize, &Checkpoint)>,
        cancellation: &'a Cancellation,
    ) -> Result<Self, ParseError> {
        let limits = options.limits.resolve()?;
        if options.filament_diameters_mm.len() > 256
            || options.filament_colors.len() > 256
            || options
                .filament_diameters_mm
                .iter()
                .any(|value| !value.is_finite() || *value <= 0.0)
        {
            return Err(ParseError::InvalidFilaments);
        }
        if range.is_some_and(|(start, end, _)| start > end || end > source.len()) {
            return Err(ParseError::InvalidWindow);
        }
        let mut parser = Self {
            cancellation,
            cancelled: false,
            source,
            options,
            limits,
            state: Checkpoint::default(),
            initial: Checkpoint::default(),
            role_indices: HashMap::new(),
            columns: Columns::default(),
            points: PathPoints::default(),
            total_points: 0,
            retain,
            range: range.map(|(start, end, _)| (start, end)),
            warnings: vec![],
            warnings_suppressed: false,
            termination: None,
            parsed_lines: 0,
            parsed_characters: 0,
            boundaries: vec![],
            checkpoint_bytes: 0,
            records_at_checkpoint: 0,
            points_at_checkpoint: 0,
            stopped_at: None,
        };
        parser.ensure_filament(
            0,
            Location {
                command_line: -1,
                ..Location::default()
            },
        );
        if let Some((_, _, checkpoint)) = range {
            parser.state = checkpoint.clone();
        }
        for (index, role) in parser.state.roles.iter().enumerate() {
            parser.role_indices.insert(role.clone(), index as u16);
        }
        parser.initial = parser.checkpoint(range.map_or(0, |range| range.0), parser.state.line);
        Ok(parser)
    }

    fn checkpoint(&self, offset: usize, line: usize) -> Checkpoint {
        let mut value = self.state.clone();
        value.offset = offset;
        value.line = line;
        value.record_offset += self.columns.count;
        value.path_point_offset += self.total_points;
        value
    }

    fn boundary(&mut self, location: Location, layer: u32) -> bool {
        if let Some(previous) = self.boundaries.last_mut()
            && previous.start_offset == location.start
        {
            previous.layer = layer;
            return true;
        }
        let s = &self.state;
        let bytes = 256
            + s.hotend_temperatures.len() * 8
            + s.roles
                .iter()
                .map(|role| 16 + role.len() * 2)
                .sum::<usize>()
            + s.filaments
                .iter()
                .map(|filament| 64 + filament.color.as_ref().map_or(0, |color| color.len() * 2))
                .sum::<usize>()
            + s.tool_filaments.len() * 32;
        if self.checkpoint_bytes + bytes > INDEX_BYTE_BUDGET {
            self.stopped_at = Some(location.start);
            self.stop(Termination::IndexCap, "index-memory-cap", "G-code checkpoint metadata exceeds the bounded index budget; only a prefix was indexed".into(), location, false);
            return false;
        }
        self.checkpoint_bytes += bytes;
        self.boundaries.push(IndexEntry {
            layer,
            start_offset: location.start,
            end_offset_exclusive: 0,
            records_before: self.columns.count,
            path_points_before: self.state.path_point_offset + self.total_points,
            checkpoint: self.checkpoint(location.start, location.line),
        });
        true
    }

    fn run(&mut self) -> Result<(), ParseError> {
        if self.cancellation.is_cancelled() {
            return Err(ParseError::Cancelled);
        }
        let (span_start, span_end) = self.range.unwrap_or((0, self.source.len()));
        let parse_end = span_end.min(span_start.saturating_add(self.limits.input_characters));
        if parse_end < span_end {
            self.termination = Some(Termination::InputCap);
            self.warn("input-character-cap", format!("G-code input exceeds the hard parse budget of {} characters; only a bounded prefix was inspected", self.limits.input_characters).into(),
                Location { line: 0, start: parse_end, end: self.source.len(), command_line: -1 }, false);
        }
        let mut start = span_start;
        let mut line = self.state.line;
        while start < parse_end && !self.stopped() {
            if self.cancellation.is_cancelled() {
                return Err(ParseError::Cancelled);
            }
            if self.parsed_lines >= self.limits.lines {
                self.stop(
                    Termination::LineCap,
                    "source-line-cap",
                    format!(
                        "G-code exceeds the hard parse budget of {} source lines",
                        self.limits.lines
                    )
                    .into(),
                    Location {
                        line,
                        start,
                        end: parse_end,
                        command_line: -1,
                    },
                    false,
                );
                break;
            }
            let mut newline = parse_end;
            for (chunk_index, chunk) in self.source[start..parse_end].chunks(4096).enumerate() {
                if self.cancellation.is_cancelled() {
                    return Err(ParseError::Cancelled);
                }
                if let Some(offset) = chunk.iter().position(|c| *c == 10) {
                    newline = start + chunk_index * 4096 + offset;
                    break;
                }
            }
            let content_end = if newline > start && self.source[newline - 1] == 13 {
                newline - 1
            } else {
                newline
            };
            let location = Location {
                line,
                start,
                end: newline,
                command_line: -1,
            };
            if !self.retain
                && self.columns.count - self.records_at_checkpoint >= self.limits.records
            {
                if !self.boundary(location, self.state.layer_count) {
                    break;
                }
                self.records_at_checkpoint = self.columns.count;
                self.points_at_checkpoint = self.total_points;
            }
            self.parsed_lines += 1;
            self.parsed_characters = newline;
            if parse_end < self.source.len()
                && newline == parse_end
                && parse_end > 0
                && self.source[parse_end - 1] != 10
            {
                self.warn(
                    "truncated-source-line",
                    "The input character cap cuts through this source line; it was not parsed"
                        .into(),
                    location,
                    false,
                );
            } else if content_end - start > self.limits.line_characters {
                self.warn(
                    "source-line-too-long",
                    format!(
                        "Source line exceeds the hard limit of {} characters and was skipped",
                        self.limits.line_characters
                    )
                    .into(),
                    location,
                    false,
                );
            } else {
                self.process_line(&self.source[start..content_end], location);
            }
            if newline >= parse_end {
                self.parsed_characters = parse_end;
                break;
            }
            start = newline + 1;
            self.parsed_characters = start;
            line += 1;
        }
        if self.cancelled || self.cancellation.is_cancelled() {
            Err(ParseError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn finish(self) -> Model {
        Model {
            record_offset: self.range.map(|_| self.state.record_offset),
            columns: self.columns,
            path_points: self.points,
            roles: self.state.roles,
            filaments: self.state.filaments,
            layer_count: self.state.layer_count,
            warnings: self.warnings,
            source_length: self.source.len(),
            parsed_characters: self.parsed_characters,
            source_line_offset: self.range.map(|_| self.state.line - 1),
            parsed_lines: self.parsed_lines,
            complete: self.termination.is_none(),
            termination_reason: self.termination,
            limits: self.limits,
        }
    }

    fn process_line(&mut self, line: &[u16], location: Location) {
        let mut start = lexer::skip_space(line, 0, line.len());
        if location.line == 1 && line.get(start) == Some(&0xfeff) {
            start = lexer::skip_space(line, start + 1, line.len());
        }
        if line.get(start) == Some(&59) {
            self.tag(&line[start + 1..], location);
            return;
        }
        let Some(command) = lexer::command(line, location, |code, message| {
            self.warn(code, message, location, false)
        }) else {
            return;
        };
        let source = Location {
            command_line: command.command_line,
            ..location
        };
        let s = &mut self.state;
        if command.letter == b'G' {
            match command.code {
                0.0 | 1.0 => self.linear(&command, source),
                2.0 | 3.0 if command.exact_arc => self.arc(&command, source, command.code == 3.0),
                20.0 => s.units_to_mm = 25.4,
                21.0 => s.units_to_mm = 1.0,
                22.0 => {
                    self.marker(kind::RETRACT, source);
                }
                23.0 => {
                    self.marker(kind::UNRETRACT, source);
                }
                90.0 => s.global_relative = false,
                91.0 => s.global_relative = true,
                92.0 => self.set_position(&command),
                _ => {}
            }
        } else if command.letter == b'M' {
            match command.code {
                82.0 => s.extruder_relative = false,
                83.0 => s.extruder_relative = true,
                104.0 => {
                    if let Some(value) = command.get(b'S') {
                        s.hotend_temperatures[s.tool as usize] = value;
                    }
                }
                106.0 => {
                    if command.get(b'P').is_none_or(|value| value == 1.0) {
                        s.fan_percent = command
                            .get(b'S')
                            .map_or(100.0, |value| (100.0 / 255.0) * value);
                    }
                }
                107.0 => s.fan_percent = 0.0,
                109.0 => {
                    if let Some(value) = command.get(b'R').or(command.get(b'S')) {
                        let target = command.get(b'R').and(command.get(b'T'));
                        match target {
                            None => s.hotend_temperatures[s.tool as usize] = value,
                            Some(tool) if tool.fract() == 0.0 && (0.0..=255.0).contains(&tool) => {
                                s.hotend_temperatures[tool as usize] = value
                            }
                            Some(tool) => self.warn(
                                "invalid-temperature-tool",
                                format!(
                                    "M109 target T{} is outside the supported range",
                                    number(tool)
                                )
                                .into(),
                                source,
                                false,
                            ),
                        }
                    }
                }
                _ => {}
            }
        } else if command.letter == b'T' {
            self.change_tool(command.code, source);
        }
    }

    fn tag(&mut self, comment: &[u16], source: Location) {
        if let Some(role) =
            lexer::prefix(comment, "TYPE:").or_else(|| lexer::prefix(comment, " FEATURE: "))
        {
            let role = lexer::text(lexer::trim(role));
            if role.is_empty() {
                self.warn(
                    "empty-role-tag",
                    "Extrusion role tag has no value".into(),
                    source,
                    false,
                );
            } else {
                self.state.role = self.role_index(role, source);
            }
            return;
        }
        for (prefixes, code, name, height) in [
            (
                ["HEIGHT:", " LAYER_HEIGHT: "],
                "invalid-height-tag",
                "layer height",
                true,
            ),
            (
                ["WIDTH:", " LINE_WIDTH: "],
                "invalid-width-tag",
                "line width",
                false,
            ),
        ] {
            if let Some(value) =
                lexer::prefix(comment, prefixes[0]).or_else(|| lexer::prefix(comment, prefixes[1]))
            {
                let text = lexer::text(lexer::trim(value));
                if let Some(parsed) = lexer::strict_number(value) {
                    let normalized = f(parsed);
                    if normalized.is_finite() {
                        if height {
                            self.state.forced_height_mm = normalized;
                        } else {
                            self.state.forced_width_mm = normalized;
                        }
                    } else {
                        self.warn(
                            code,
                            Text::surround(
                                if height {
                                    "Layer height tag \""
                                } else {
                                    "Line width tag \""
                                },
                                &text,
                                "\" exceeds Float32",
                            ),
                            source,
                            false,
                        );
                    }
                } else {
                    self.warn(
                        code,
                        Text::surround(&format!("Invalid {name} tag \""), &text, "\""),
                        source,
                        false,
                    );
                }
                return;
            }
        }
        let exact = lexer::trim_end(comment);
        if lexer::eq(exact, "LAYER_CHANGE") || lexer::eq(exact, " CHANGE_LAYER") {
            if !self.retain && !self.boundary(source, self.state.layer_count + 1) {
                return;
            }
            self.records_at_checkpoint = self.columns.count;
            self.points_at_checkpoint = self.total_points;
            self.state.layer_count += 1;
            self.marker(kind::LAYER_CHANGE, source);
            return;
        }
        if lexer::prefix(comment, "WIPE_START")
            .or_else(|| lexer::prefix(comment, " WIPE_START"))
            .is_some()
        {
            self.state.wiping = true;
            self.marker(kind::WIPE_START, source);
            return;
        }
        if lexer::prefix(comment, "WIPE_END")
            .or_else(|| lexer::prefix(comment, " WIPE_END"))
            .is_some()
        {
            self.state.wiping = false;
            self.marker(kind::WIPE_END, source);
            return;
        }
        if let Some(value) = lexer::prefix(comment, "COLOR_CHANGE")
            .or_else(|| lexer::prefix(comment, " COLOR_CHANGE"))
        {
            self.color_change(value, source);
            return;
        }
        if lexer::eq(exact, "PAUSE_PRINT") || lexer::eq(exact, " PAUSE_PRINTING") {
            self.marker(kind::PAUSE, source);
            return;
        }
        if lexer::eq(exact, "CUSTOM_GCODE") || lexer::eq(exact, " CUSTOM_GCODE") {
            self.marker(kind::CUSTOM, source);
            return;
        }
        if let Some(value) = lexer::prefix(comment, " MANUAL_TOOL_CHANGE ") {
            let value = lexer::text(lexer::trim(value));
            let utf8 = value.utf8();
            let tool = utf8
                .as_deref()
                .and_then(|v| v.strip_prefix('T').or_else(|| v.strip_prefix('t')));
            if let Some(tool) =
                tool.filter(|v| !v.is_empty() && v.bytes().all(|c| c.is_ascii_digit()))
            {
                self.change_tool(tool.parse().unwrap_or(f64::INFINITY), source);
            } else {
                self.warn(
                    "invalid-manual-tool-change",
                    Text::surround("Invalid manual tool change marker \"", &value, "\""),
                    source,
                    false,
                );
            }
        }
    }

    fn scaled(&self, value: f64) -> f64 {
        if self.state.units_to_mm == 1.0 {
            value
        } else {
            f(value * f(self.state.units_to_mm))
        }
    }
    fn axis(&self, command: &Command, axis: u8, current: f64, origin: f64, extrusion: bool) -> f64 {
        command.get(axis).map_or(current, |value| {
            let value = self.scaled(value);
            if self.state.global_relative || (extrusion && self.state.extruder_relative) {
                current + value
            } else {
                origin + value
            }
        })
    }
    fn endpoints(&self, command: &Command) -> [f64; 4] {
        let s = &self.state;
        [
            self.axis(command, b'X', s.x, s.origin_x, false),
            self.axis(command, b'Y', s.y, s.origin_y, false),
            self.axis(command, b'Z', s.z, s.origin_z, false),
            self.axis(command, b'E', s.e, s.origin_e, true),
        ]
    }
    fn advance(&mut self, end: [f64; 4]) {
        [self.state.x, self.state.y, self.state.z, self.state.e] = end;
    }
    fn feed(&mut self, command: &Command, source: Location) -> f64 {
        if let Some(feed) = command.get(b'F') {
            let value = f(feed * f(1.0 / 60.0));
            if value < 0.0 {
                self.warn(
                    "negative-feedrate",
                    format!("Negative feedrate {} was ignored", number(feed)).into(),
                    source,
                    false,
                );
            } else {
                return value;
            }
        }
        self.state.feedrate_mm_per_second
    }
    fn diameter(&self) -> f64 {
        self.options
            .filament_diameters_mm
            .get(self.state.tool as usize)
            .or_else(|| self.options.filament_diameters_mm.last())
            .copied()
            .unwrap_or(1.75)
    }
    fn record(&self, kind: u8, source: Location) -> Record {
        let s = &self.state;
        Record {
            kind,
            start: [s.x, s.y, s.z],
            end: [s.x, s.y, s.z],
            delta_e: 0.0,
            feedrate: s.feedrate_mm_per_second,
            width: 0.0,
            height: 0.0,
            mm3_per_mm: 0.0,
            flow: 0.0,
            fan: s.fan_percent,
            temperature: s.hotend_temperatures[s.tool as usize],
            layer: s.layer_count,
            role: s.role,
            tool: s.tool,
            filament: s.filament,
            source,
            path_kind: 0,
            points: PathPoints::default(),
            center: [0.0; 2],
        }
    }
    fn marker(&mut self, kind: u8, source: Location) {
        self.emit(self.record(kind, source));
    }

    fn linear(&mut self, command: &Command, source: Location) {
        let mut end = self.endpoints(command);
        self.state.feedrate_mm_per_second = self.feed(command, source);
        let [dx, dy, dz, de] = [
            end[0] - self.state.x,
            end[1] - self.state.y,
            end[2] - self.state.z,
            end[3] - self.state.e,
        ];
        if dx == 0.0 && dy == 0.0 && dz == 0.0 && de == 0.0 {
            return;
        }
        let spatial = dx != 0.0 || dy != 0.0 || dz != 0.0;
        let kind = if self.state.wiping {
            kind::WIPE
        } else if de < 0.0 {
            if spatial { kind::TRAVEL } else { kind::RETRACT }
        } else if de > 0.0 {
            if dx == 0.0 && dy == 0.0 {
                if dz == 0.0 {
                    kind::UNRETRACT
                } else {
                    kind::TRAVEL
                }
            } else {
                kind::EXTRUDE
            }
        } else if spatial {
            kind::TRAVEL
        } else {
            kind::NOOP
        };
        let mut record = self.record(kind, source);
        if kind == kind::EXTRUDE {
            let distance = dx.hypot(dy).hypot(dz);
            let diameter = self.diameter();
            let area = PI * (diameter * 0.5).powi(2);
            record.mm3_per_mm = if distance > 0.0 {
                area * de / distance
            } else {
                0.0
            };
            record.flow = record.mm3_per_mm * self.state.feedrate_mm_per_second;
            let s = &mut self.state;
            let last = f(s.extruded_last_z);
            s.current_height_mm = f(s.current_height_mm);
            if s.forced_height_mm > 0.0 {
                s.current_height_mm = f(s.forced_height_mm);
            } else if end[2] > last + 1e-4 {
                s.current_height_mm = f(end[2] - last);
            }
            if s.current_height_mm == 0.0 {
                s.current_height_mm = f(0.2);
            }
            if end[2] == 0.0 {
                end[2] = s.current_height_mm;
            }
            s.extruded_last_z = f(end[2]);
            s.current_width_mm = if s.forced_width_mm > 0.0 {
                f(s.forced_width_mm)
            } else {
                f(arc::width(
                    &s.roles[s.role as usize],
                    diameter,
                    de,
                    distance,
                    s.current_height_mm,
                ))
            };
            record.width = s.current_width_mm;
            record.height = s.current_height_mm;
        } else if kind == kind::WIPE {
            record.width = 0.05;
            record.height = 0.05;
        }
        record.end = [end[0], end[1], end[2]];
        record.delta_e = de;
        if self.emit(record) {
            self.advance(end);
        }
    }

    fn arc(&mut self, command: &Command, source: Location, ccw: bool) {
        let start = [self.state.x, self.state.y, self.state.z, self.state.e];
        let mut end = self.endpoints(command);
        if !start.into_iter().chain(end).all(finite_f32) {
            self.unsafe_arc(
                "arc-coordinate-range",
                "Arc coordinates are outside the finite Float32 domain",
                source,
            );
            return;
        }
        if b"XYZEIJPF".iter().any(|letter| command.invalid(*letter)) {
            self.unsafe_arc(
                "arc-parameter-range",
                "Arc parameters are outside the finite Float32 domain",
                source,
            );
            return;
        }
        if command.get(b'I').is_none() && command.get(b'J').is_none() {
            self.warn(
                "missing-arc-center",
                "G2/G3 requires at least one I/J center offset".into(),
                source,
                true,
            );
            self.advance(end);
            return;
        }
        let turns = command.get(b'P').map(f);
        if turns.is_some_and(|value| {
            !value.is_finite() || value.trunc() != 1.0 || start[0] != end[0] || start[1] != end[1]
        }) {
            self.warn("invalid-arc-turns", "G2/G3 P mode requires a Float32 turn value whose truncated integer is 1 and an endpoint whose X/Y exactly matches the start".into(), source, true);
            self.advance(end);
            return;
        }
        let center = [
            start[0] + self.scaled(command.get(b'I').unwrap_or(0.0)),
            start[1] + self.scaled(command.get(b'J').unwrap_or(0.0)),
        ];
        if !center.into_iter().all(finite_f32) {
            self.unsafe_arc(
                "arc-center-range",
                "Arc center coordinates are outside the finite Float32 domain",
                source,
            );
            return;
        }
        let arc_start = [f(start[0]), f(start[1]), f(start[2])];
        let arc_end = [f(end[0]), f(end[1]), f(end[2])];
        let center = center.map(f);
        let radius = arc::length(f(arc_start[0] - center[0]), f(arc_start[1] - center[1]));
        let angle = arc::radians(
            [arc_start[0], arc_start[1]],
            [arc_end[0], arc_end[1]],
            center,
            ccw,
        );
        let length = turns.map_or_else(
            || f(radius * angle),
            |turns| f(turns.trunc() * 2.0 * PI * radius),
        );
        let dz = end[2] - start[2];
        let arc_dz = f(arc_end[2] - arc_start[2]);
        let de = end[3] - start[3];
        let distance = f((f(length * length) + dz * dz).sqrt());
        if ![radius, angle, length, dz, arc_dz, de, distance]
            .into_iter()
            .all(finite_f32)
        {
            self.unsafe_arc(
                "arc-metric-range",
                "Arc geometry exceeds the finite Float32 metric domain",
                source,
            );
            return;
        }
        let feed = self.feed(command, source);
        if !finite_f32(feed) {
            self.unsafe_arc(
                "arc-feedrate-range",
                "Arc feedrate is outside the finite Float32 domain",
                source,
            );
            return;
        }
        if length == 0.0 && dz == 0.0 {
            self.advance(end);
            self.state.feedrate_mm_per_second = feed;
            return;
        }
        if self.retain && self.columns.count == self.limits.records {
            self.record_cap(source);
            return;
        }
        let Some(plan) = arc::plan(radius, angle, arc_dz) else {
            self.unsafe_arc(
                "arc-interpolation-range",
                "Arc interpolation step or point count is outside the bounded numeric domain",
                source,
            );
            return;
        };
        if !self.retain
            && plan.count <= self.limits.path_points
            && self.total_points - self.points_at_checkpoint + plan.count as u64
                > self.limits.path_points as u64
        {
            if !self.boundary(source, self.state.layer_count) {
                return;
            }
            self.records_at_checkpoint = self.columns.count;
            self.points_at_checkpoint = self.total_points;
        }
        let remaining = if self.retain {
            self.limits.path_points as u64 - self.total_points
        } else {
            MAX_SAFE_INTEGER
        };
        if plan.count as u64 > remaining.min(self.limits.path_points as u64) {
            self.stop(Termination::PathPointCap, "arc-path-point-cap", format!("Arc interpolation exceeds the remaining bounded path-point budget of {remaining}").into(), source, true);
            return;
        }
        let points = match arc::points(plan, arc_start, center, ccw, self.retain, self.cancellation)
        {
            Ok(points) => points,
            Err(_) => {
                self.cancelled = true;
                return;
            }
        };
        let Some(points) = points else {
            self.unsafe_arc(
                "arc-interpolation-range",
                "Arc interpolation produced a point outside the finite Float32 domain",
                source,
            );
            return;
        };
        let kind = if de == 0.0 {
            kind::TRAVEL
        } else {
            kind::EXTRUDE
        };
        let mut record = self.record(kind, source);
        let mut next_height = f(self.state.current_height_mm);
        let mut next_width = f(self.state.current_width_mm);
        let mut next_last_z = f(self.state.extruded_last_z);
        if kind == kind::EXTRUDE {
            let diameter = f(self.diameter());
            let radius = f(0.5 * diameter);
            let area = f(f(PI) * f(radius * radius));
            let volume = f(area * de);
            record.mm3_per_mm = if distance > 0.0 {
                f(volume / distance)
            } else {
                0.0
            };
            record.flow = f(record.mm3_per_mm * feed);
            if self.state.forced_height_mm > 0.0 {
                next_height = self.state.forced_height_mm;
            } else if end[2] > next_last_z + 1e-4 {
                next_height = f(end[2] - next_last_z);
            }
            if next_height == 0.0 {
                next_height = f(0.2);
            }
            if end[2] == 0.0 {
                end[2] = next_height;
            }
            next_last_z = f(end[2]);
            next_width = arc::arc_width(
                &self.state.roles[self.state.role as usize],
                diameter,
                radius,
                de,
                distance,
                next_height,
                self.state.forced_width_mm,
            );
            record.width = next_width;
            record.height = next_height;
        }
        record.end = [end[0], end[1], end[2]];
        record.delta_e = de;
        record.feedrate = feed;
        record.path_kind = if ccw { 3 } else { 2 };
        record.points = points;
        record.center = center;
        if !record.finite() {
            self.unsafe_arc(
                "arc-record-range",
                "Arc record metadata is outside the finite Float32 domain",
                source,
            );
            return;
        }
        if !self.emit(record) {
            return;
        }
        self.advance(end);
        self.state.feedrate_mm_per_second = feed;
        self.state.current_height_mm = next_height;
        self.state.current_width_mm = next_width;
        self.state.extruded_last_z = next_last_z;
    }

    fn set_position(&mut self, command: &Command) {
        let mut found = false;
        if let Some(x) = command.get(b'X') {
            self.state.origin_x = self.state.x - self.scaled(x);
            found = true;
        }
        if let Some(y) = command.get(b'Y') {
            self.state.origin_y = self.state.y - self.scaled(y);
            found = true;
        }
        if let Some(z) = command.get(b'Z') {
            self.state.origin_z = self.state.z - self.scaled(z);
            found = true;
        }
        if let Some(e) = command.get(b'E') {
            self.state.e = self.scaled(e);
            found = true;
        }
        let unknown =
            command.parameters.iter().enumerate().any(|(index, value)| {
                value.is_some() && !b"XYZEFIJP".contains(&(index as u8 + b'A'))
            });
        if !found && !unknown {
            self.state.origin_x = self.state.x;
            self.state.origin_y = self.state.y;
            self.state.origin_z = self.state.z;
            self.state.origin_e = self.state.e;
        }
    }

    fn color_change(&mut self, value: &[u16], source: Location) {
        let tokens: Vec<Text> = value
            .split(|c| *c == 44)
            .map(|part| lexer::text(lexer::trim(part)))
            .collect();
        let mut tool = 0;
        if let Some(value) = tokens.get(1).filter(|value| !value.is_empty()) {
            let utf8 = value.utf8();
            let digits = utf8
                .as_deref()
                .unwrap_or("")
                .strip_prefix('T')
                .filter(|value| !value.is_empty() && value.bytes().all(|c| c.is_ascii_digit()));
            let parsed = digits
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|value| *value <= 255.0);
            if let Some(value) = parsed {
                tool = value as u16;
            } else {
                self.warn(
                    "invalid-color-change-tool",
                    Text::surround("Invalid color-change tool \"", value, "\""),
                    source,
                    false,
                );
                return;
            }
        }
        let color = if let Some(value) = tokens.get(2).and_then(Text::utf8).filter(|v| {
            v.len() == 7
                && v.starts_with('#')
                && v.as_bytes()[1..].iter().all(|c| c.is_ascii_hexdigit())
        }) {
            Text::from(value.to_ascii_uppercase())
        } else {
            if let Some(value) = tokens.get(2).filter(|v| !v.is_empty()) {
                self.warn(
                    "invalid-color-change-color",
                    Text::surround("Invalid color-change value \"", value, "\""),
                    source,
                    false,
                );
            }
            let color = COLORS[self.state.default_color_index].into();
            self.state.default_color_index = (self.state.default_color_index + 1) % COLORS.len();
            color
        };
        let filament = self.create_filament(tool, "color-change", Some(color), source);
        self.set_tool_filament(tool, filament);
        if tool == self.state.tool {
            self.state.filament = filament;
            self.marker(kind::COLOR_CHANGE, source);
        }
    }

    fn change_tool(&mut self, tool: f64, source: Location) {
        if tool.fract() != 0.0 || !(0.0..=254.0).contains(&tool) {
            if tool != 255.0 && tool != 1000.0 && tool != 1100.0 {
                self.warn(
                    "invalid-tool-command",
                    format!(
                        "Tool T{} is outside the supported 0..254 range",
                        number(tool)
                    )
                    .into(),
                    source,
                    false,
                );
            }
            return;
        }
        let tool = tool as u16;
        if tool == self.state.tool {
            return;
        }
        self.state.tool = tool;
        self.state.filament = self.ensure_filament(tool, source);
        self.marker(kind::TOOL_CHANGE, source);
    }
    fn role_index(&mut self, role: Text, source: Location) -> u16 {
        if let Some(index) = self.role_indices.get(&role) {
            return *index;
        }
        if self.state.roles.len() >= self.limits.roles {
            self.warn(
                "role-table-cap",
                Text::surround(
                    &format!(
                        "Role table reached the hard limit of {}; \"",
                        self.limits.roles
                    ),
                    &role,
                    "\" maps to Undefined",
                ),
                source,
                false,
            );
            return 0;
        }
        let index = self.state.roles.len() as u16;
        self.state.roles.push(role.clone());
        self.role_indices.insert(role, index);
        index
    }
    fn tool_filament(&self, tool: u16) -> Option<u16> {
        self.state
            .tool_filaments
            .iter()
            .find_map(|(key, value)| (*key == tool).then_some(*value))
    }
    fn set_tool_filament(&mut self, tool: u16, filament: u16) {
        if let Some(pair) = self
            .state
            .tool_filaments
            .iter_mut()
            .find(|(key, _)| *key == tool)
        {
            pair.1 = filament;
        } else {
            self.state.tool_filaments.push((tool, filament));
        }
    }
    fn ensure_filament(&mut self, tool: u16, source: Location) -> u16 {
        if let Some(filament) = self.tool_filament(tool) {
            return filament;
        }
        let color = self
            .options
            .filament_colors
            .get(tool as usize)
            .cloned()
            .filter(|s| !s.is_empty());
        let filament = self.create_filament(tool, "tool", color, source);
        self.set_tool_filament(tool, filament);
        filament
    }
    fn create_filament(
        &mut self,
        tool: u16,
        source_type: &'static str,
        color: Option<Text>,
        source: Location,
    ) -> u16 {
        if self.state.filaments.len() >= self.limits.filaments {
            self.warn(
                "filament-table-cap",
                format!(
                    "Filament identity table reached the hard limit of {}",
                    self.limits.filaments
                )
                .into(),
                source,
                false,
            );
            return self.tool_filament(tool).unwrap_or(0);
        }
        let id = self.state.filaments.len() as u16;
        self.state.filaments.push(Filament {
            id,
            tool,
            source: source_type,
            color,
        });
        id
    }

    fn record_cap(&mut self, source: Location) {
        self.stop(
            Termination::RecordCap,
            "record-cap",
            format!(
                "Classified record count reached the hard limit of {}",
                self.limits.records
            )
            .into(),
            source,
            false,
        );
    }
    fn emit(&mut self, record: Record) -> bool {
        if self.retain && self.columns.count >= self.limits.records {
            self.record_cap(record.source);
            return false;
        }
        if self.retain && record.points.count + self.points.count > self.limits.path_points {
            self.stop(
                Termination::PathPointCap,
                "arc-path-point-cap",
                format!(
                    "Arc interpolation would exceed the hard limit of {} path points",
                    self.limits.path_points
                )
                .into(),
                record.source,
                true,
            );
            return false;
        }
        if self.retain {
            self.columns
                .push(&record, self.points.count, self.limits.records);
            self.points.count += record.points.count;
            for (target, data) in [
                (&mut self.points.x, record.points.x),
                (&mut self.points.y, record.points.y),
                (&mut self.points.z, record.points.z),
            ] {
                if target.is_empty() {
                    *target = data;
                    continue;
                }
                if target.capacity() < self.points.count {
                    let capacity = self
                        .points
                        .count
                        .max(target.capacity().max(512).saturating_mul(2))
                        .min(self.limits.path_points);
                    target.reserve_exact(capacity - target.len());
                }
                target.extend(data);
            }
        } else {
            self.columns.count += 1;
        }
        self.total_points += record.points.count as u64;
        true
    }
    fn warn(&mut self, code: &'static str, message: Text, source: Location, error: bool) {
        if self.warnings_suppressed {
            return;
        }
        let warning = Warning {
            code,
            message,
            line: source.line,
            start_offset: source.start,
            end_offset: source.end,
            severity: if error { "error" } else { "warning" },
        };
        if self.warnings.len() < self.limits.warnings {
            self.warnings.push(warning);
        } else {
            self.warnings_suppressed = true;
            self.warnings[self.limits.warnings - 1] = Warning {
                code: "warning-cap",
                severity: "warning",
                message: format!(
                    "Additional parser warnings were suppressed after reaching the hard limit of {}",
                    self.limits.warnings
                ).into(),
                ..warning
            };
        }
    }
    fn stop(
        &mut self,
        reason: Termination,
        code: &'static str,
        message: Text,
        source: Location,
        error: bool,
    ) {
        if self.termination.is_none() || self.termination == Some(Termination::InputCap) {
            self.termination = Some(reason);
        }
        self.warn(code, message, source, error);
    }
    fn unsafe_arc(&mut self, code: &'static str, message: &str, source: Location) {
        self.stop(Termination::NumericCap, code, message.into(), source, true);
    }
    fn stopped(&self) -> bool {
        self.cancelled
            || self
                .termination
                .is_some_and(|reason| reason != Termination::InputCap)
    }
}
