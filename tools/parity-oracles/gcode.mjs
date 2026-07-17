import { readFileSync } from "node:fs";

const DEFAULT_TOLERANCES = Object.freeze({
  boundsMm: 0.01,
  estimateAbsolute: 0.05,
  estimateRelative: 0.02,
  extrusionAbsoluteMm: 0.05,
  extrusionRelative: 0.005,
  layerZMm: 0.001,
  temperatureC: 0.1,
});

function round(value, places = 9) {
  if (!Number.isFinite(value)) return value;
  const factor = 10 ** places;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function addTo(record, key, value) {
  record[key] = (record[key] ?? 0) + value;
}

function words(command) {
  const result = {};
  for (const match of command.matchAll(
    /(?:^|\s)([A-Za-z])\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?)/g,
  )) {
    result[match[1].toUpperCase()] = Number(match[2]);
  }
  return result;
}

function normalizeWarning(comment) {
  return comment
    .trim()
    .replace(/^[_;\s]+/, "")
    .replace(/\s+/g, " ");
}

function durationSeconds(value) {
  let total = 0;
  let matched = false;
  for (const match of value.matchAll(
    /([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(d|h|m|s)\b/gi,
  )) {
    matched = true;
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    total += amount * { d: 86400, h: 3600, m: 60, s: 1 }[unit];
  }
  return matched ? total : null;
}

function estimateValue(raw) {
  const duration = durationSeconds(raw);
  if (duration !== null) return round(duration);
  const numbers = [
    ...raw.matchAll(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?/g),
  ].map((match) => Number(match[0]));
  if (numbers.length === 0) return raw.trim().replace(/\s+/g, " ");
  return numbers.length === 1
    ? round(numbers[0])
    : numbers.map((number) => round(number));
}

function maybeEstimate(comment, estimates) {
  const match = comment.match(/^\s*([^=]+?)\s*=\s*(.+?)\s*$/);
  if (
    !match ||
    !/(?:estimated|printing time|filament|material|cost|layer count|total layer)/i.test(
      match[1],
    )
  )
    return;
  const key = match[1].trim().toLowerCase().replace(/\s+/g, " ");
  estimates[key] = estimateValue(match[2]);
}

function updateBounds(bounds, position) {
  for (const axis of ["x", "y", "z"]) {
    const value = position[axis];
    bounds.min[axis] = Math.min(bounds.min[axis], value);
    bounds.max[axis] = Math.max(bounds.max[axis], value);
  }
}

function angleOnSweep(angle, start, end, clockwise) {
  const tau = Math.PI * 2;
  const normalized = (value) => ((value % tau) + tau) % tau;
  const a = normalized(angle);
  const s = normalized(start);
  const e = normalized(end);
  if (clockwise) return normalized(s - a) <= normalized(s - e) + 1e-12;
  return normalized(a - s) <= normalized(e - s) + 1e-12;
}

function updateArcBounds(bounds, start, end, params, units, clockwise) {
  updateBounds(bounds, start);
  updateBounds(bounds, end);
  if (params.I === undefined && params.J === undefined) return;
  const centerX = start.x + (params.I ?? 0) * units;
  const centerY = start.y + (params.J ?? 0) * units;
  const radius = Math.hypot(start.x - centerX, start.y - centerY);
  if (!(radius > 0)) return;
  const startAngle = Math.atan2(start.y - centerY, start.x - centerX);
  const endAngle = Math.atan2(end.y - centerY, end.x - centerX);
  for (const angle of [0, Math.PI / 2, Math.PI, Math.PI * 1.5]) {
    if (!angleOnSweep(angle, startAngle, endAngle, clockwise)) continue;
    updateBounds(bounds, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      z: Math.min(start.z, end.z),
    });
    updateBounds(bounds, {
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      z: Math.max(start.z, end.z),
    });
  }
}

function finalizeBounds(bounds) {
  const result = { max: {}, min: {} };
  for (const axis of ["x", "y", "z"]) {
    result.min[axis] = Number.isFinite(bounds.min[axis])
      ? round(bounds.min[axis])
      : null;
    result.max[axis] = Number.isFinite(bounds.max[axis])
      ? round(bounds.max[axis])
      : null;
  }
  return result;
}

function sortedRoundedRecord(record) {
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) =>
        left.localeCompare(right, "en", { numeric: true }),
      )
      .map(([key, value]) => [key, round(value)]),
  );
}

/** Parse G-code into print semantics instead of comparing unstable comments/formatting. */
export function parseGcodeText(input) {
  const source = String(input)
    .replace(/^\uFEFF/, "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n");
  const state = {
    e: 0,
    eAbsolute: true,
    inTower: false,
    layer: null,
    layerMarkerStyle: null,
    role: "Unclassified",
    tool: 0,
    units: 1,
    xyzAbsolute: true,
    x: 0,
    y: 0,
    z: 0,
  };
  const layers = [];
  const toolSelections = [];
  const toolChanges = [];
  const extrusionByTool = {};
  const extrusionByRole = {};
  const extrusionByContext = {};
  const allBounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  const extrusionBounds = {
    min: { x: Infinity, y: Infinity, z: Infinity },
    max: { x: -Infinity, y: -Infinity, z: -Infinity },
  };
  const temperatures = [];
  const warnings = new Set();
  const estimates = {};

  const beginLayer = (declaredIndex = null) => {
    const layer = {
      index: layers.length,
      declaredIndex,
      extrusionTools: new Set(),
      roles: new Set(),
      tools: [],
      z: null,
    };
    layers.push(layer);
    state.layer = layer;
  };

  const selectTool = (tool, lineNumber, command) => {
    if (!Number.isInteger(tool) || tool < 0) return;
    const selection = {
      command,
      layer: state.layer?.index ?? null,
      line: lineNumber,
      tool,
    };
    toolSelections.push(selection);
    state.layer?.tools.push(tool);
    if (tool !== state.tool)
      toolChanges.push({
        from: state.tool,
        layer: state.layer?.index ?? null,
        to: tool,
      });
    state.tool = tool;
  };

  const lines = source.split("\n");
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineNumber = lineIndex + 1;
    let raw = lines[lineIndex].trim();
    if (!raw) continue;
    raw = raw
      .replace(/^N\d+\s+/, "")
      .replace(/\*\d+\s*$/, "")
      .trim();
    const semicolon = raw.indexOf(";");
    const command = (semicolon < 0 ? raw : raw.slice(0, semicolon)).trim();
    const comment = semicolon < 0 ? "" : raw.slice(semicolon + 1).trim();

    if (comment) {
      if (/^LAYER_CHANGE\b/i.test(comment)) {
        if (state.layerMarkerStyle === null)
          state.layerMarkerStyle = "LAYER_CHANGE";
        if (state.layerMarkerStyle === "LAYER_CHANGE") beginLayer();
      } else {
        const layerMatch =
          comment.match(/^LAYER\s*:\s*(-?\d+)\b/i) ??
          comment.match(/^layer_num\s*=\s*(-?\d+)\b/i);
        if (layerMatch && state.layerMarkerStyle !== "LAYER_CHANGE") {
          if (state.layerMarkerStyle === null)
            state.layerMarkerStyle = "INDEXED";
          beginLayer(Number(layerMatch[1]));
        }
      }
      const zMatch =
        comment.match(/^Z\s*:\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/i) ??
        comment.match(/^layer_z\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))/i);
      if (zMatch && state.layer) state.layer.z = round(Number(zMatch[1]));
      const roleMatch = comment.match(
        /^(?:TYPE\s*:|_EXTRUSION_ROLE\s*:?)\s*(.+)$/i,
      );
      if (roleMatch) {
        state.role = roleMatch[1].trim().replace(/\s+/g, " ");
        state.layer?.roles.add(state.role);
        state.inTower = /(?:prime|wipe) tower/i.test(state.role);
      }
      if (/(?:WIPE_TOWER|PRIME_TOWER)_START|CP TOOLCHANGE START/i.test(comment))
        state.inTower = true;
      if (/(?:WIPE_TOWER|PRIME_TOWER)_END|CP TOOLCHANGE END/i.test(comment))
        state.inTower = false;
      if (/(?:^|[_\s])(WARNING|ERROR)(?:\s|:|$)/i.test(comment))
        warnings.add(normalizeWarning(comment));
      maybeEstimate(comment, estimates);
    }
    if (!command) continue;

    const upper = command.toUpperCase();
    const standaloneTool = upper.match(/^T(\d+)\b/);
    if (standaloneTool) {
      selectTool(Number(standaloneTool[1]), lineNumber, "T");
      continue;
    }
    const activate = command.match(
      /^ACTIVATE_EXTRUDER\b.*\bEXTRUDER\s*=\s*(?:extruder)?(\d+)\b/i,
    );
    if (activate) {
      selectTool(Number(activate[1]), lineNumber, "ACTIVATE_EXTRUDER");
      continue;
    }

    const opcodeMatch = upper.match(/^([GMT]\d+(?:\.\d+)?)\b/);
    if (!opcodeMatch) continue;
    const opcode = opcodeMatch[1];
    const params = words(command);
    if (
      (opcode === "M6" || opcode === "M06" || opcode === "M135") &&
      params.T !== undefined
    ) {
      selectTool(params.T, lineNumber, opcode);
    }
    if (opcode === "G20") state.units = 25.4;
    else if (opcode === "G21") state.units = 1;
    else if (opcode === "G90") state.xyzAbsolute = true;
    else if (opcode === "G91") state.xyzAbsolute = false;
    else if (opcode === "M82") state.eAbsolute = true;
    else if (opcode === "M83") state.eAbsolute = false;
    else if (opcode === "G92") {
      for (const axis of ["X", "Y", "Z"]) {
        if (params[axis] !== undefined)
          state[axis.toLowerCase()] = params[axis] * state.units;
      }
      if (params.E !== undefined) state.e = params.E * state.units;
    }

    if (["M104", "M109", "M140", "M190", "M141", "M191"].includes(opcode)) {
      const value = params.S ?? params.R;
      if (value !== undefined) {
        const nozzle = opcode === "M104" || opcode === "M109";
        temperatures.push({
          kind: nozzle
            ? "nozzle"
            : opcode === "M140" || opcode === "M190"
              ? "bed"
              : "chamber",
          tool: nozzle ? (params.T ?? state.tool) : null,
          value: round(value),
          wait: ["M109", "M190", "M191"].includes(opcode),
        });
      }
    }

    if (!["G0", "G00", "G1", "G01", "G2", "G02", "G3", "G03"].includes(opcode))
      continue;
    const start = { x: state.x, y: state.y, z: state.z };
    const next = { ...start };
    for (const axis of ["X", "Y", "Z"]) {
      if (params[axis] === undefined) continue;
      const value = params[axis] * state.units;
      next[axis.toLowerCase()] = state.xyzAbsolute
        ? value
        : state[axis.toLowerCase()] + value;
    }
    let extrusion = 0;
    if (params.E !== undefined) {
      const value = params.E * state.units;
      extrusion = state.eAbsolute ? value - state.e : value;
      state.e = state.eAbsolute ? value : state.e + value;
    }
    state.x = next.x;
    state.y = next.y;
    state.z = next.z;
    const arc = ["G2", "G02", "G3", "G03"].includes(opcode);
    if (arc)
      updateArcBounds(
        allBounds,
        start,
        next,
        params,
        state.units,
        opcode === "G2" || opcode === "G02",
      );
    else updateBounds(allBounds, next);
    if (state.layer && state.layer.z === null && params.Z !== undefined)
      state.layer.z = round(next.z);
    if (extrusion > 0) {
      if (arc)
        updateArcBounds(
          extrusionBounds,
          start,
          next,
          params,
          state.units,
          opcode === "G2" || opcode === "G02",
        );
      else {
        updateBounds(extrusionBounds, start);
        updateBounds(extrusionBounds, next);
      }
      addTo(extrusionByTool, String(state.tool), extrusion);
      addTo(extrusionByRole, state.role, extrusion);
      addTo(extrusionByContext, state.inTower ? "tower" : "model", extrusion);
      state.layer?.extrusionTools.add(state.tool);
      state.layer?.roles.add(state.role);
    }
  }

  return {
    format: "orcaxr-semantic-gcode-v1",
    layers: layers.map((layer) => ({
      declaredIndex: layer.declaredIndex,
      extrusionTools: [...layer.extrusionTools].sort(
        (left, right) => left - right,
      ),
      index: layer.index,
      roles: [...layer.roles].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
      tools: layer.tools,
      z: layer.z,
    })),
    toolOrder: toolSelections.map((selection) => selection.tool),
    toolChanges: toolChanges.map(({ from, layer, to }) => ({
      from,
      layer,
      to,
    })),
    roles: Object.keys(extrusionByRole).sort((left, right) =>
      left.localeCompare(right, "en"),
    ),
    bounds: finalizeBounds(allBounds),
    extrusionBounds: finalizeBounds(extrusionBounds),
    extrusion: {
      byContext: sortedRoundedRecord(extrusionByContext),
      byRole: sortedRoundedRecord(extrusionByRole),
      byTool: sortedRoundedRecord(extrusionByTool),
      total: round(
        Object.values(extrusionByTool).reduce((sum, value) => sum + value, 0),
      ),
    },
    temperatures,
    estimates: Object.fromEntries(
      Object.entries(estimates).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    ),
    warnings: [...warnings].sort((left, right) =>
      left.localeCompare(right, "en"),
    ),
  };
}

export function parseGcodeFile(path) {
  return parseGcodeText(readFileSync(path, "utf8"));
}

function addDifference(differences, path, expected, actual, tolerance = null) {
  differences.push({
    actual,
    expected,
    path,
    ...(tolerance === null ? {} : { tolerance }),
  });
}

function compareExact(expected, actual, path, differences) {
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    addDifference(differences, path, expected, actual);
}

function withinNumericTolerance(expected, actual, absolute, relative) {
  if (expected === null || actual === null) return expected === actual;
  if (!Number.isFinite(expected) || !Number.isFinite(actual))
    return Object.is(expected, actual);
  return (
    Math.abs(expected - actual) <=
    Math.max(
      absolute,
      Math.max(Math.abs(expected), Math.abs(actual)) * relative,
    )
  );
}

function compareNumeric(
  expected,
  actual,
  path,
  differences,
  absolute,
  relative = 0,
) {
  if (!withinNumericTolerance(expected, actual, absolute, relative)) {
    addDifference(differences, path, expected, actual, { absolute, relative });
  }
}

function compareNumericRecord(
  expected,
  actual,
  path,
  differences,
  absolute,
  relative,
) {
  const keys = [
    ...new Set([...Object.keys(expected), ...Object.keys(actual)]),
  ].sort();
  for (const key of keys) {
    if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) {
      addDifference(differences, `${path}/${key}`, expected[key], actual[key]);
    } else {
      compareNumeric(
        expected[key],
        actual[key],
        `${path}/${key}`,
        differences,
        absolute,
        relative,
      );
    }
  }
}

function compareEstimate(expected, actual, path, differences, tolerances) {
  if (typeof expected === "number" && typeof actual === "number") {
    compareNumeric(
      expected,
      actual,
      path,
      differences,
      tolerances.estimateAbsolute,
      tolerances.estimateRelative,
    );
  } else if (
    Array.isArray(expected) &&
    Array.isArray(actual) &&
    expected.length === actual.length
  ) {
    for (let index = 0; index < expected.length; index += 1) {
      compareEstimate(
        expected[index],
        actual[index],
        `${path}/${index}`,
        differences,
        tolerances,
      );
    }
  } else {
    compareExact(expected, actual, path, differences);
  }
}

/** Compare parsed G-code semantics with explicit numeric tolerances. */
export function compareGcodeText(expectedText, actualText, options = {}) {
  const tolerances = { ...DEFAULT_TOLERANCES, ...(options.tolerances ?? {}) };
  const expected = parseGcodeText(expectedText);
  const actual = parseGcodeText(actualText);
  const differences = [];
  compareExact(expected.toolOrder, actual.toolOrder, "/toolOrder", differences);
  compareExact(
    expected.toolChanges,
    actual.toolChanges,
    "/toolChanges",
    differences,
  );
  compareExact(expected.roles, actual.roles, "/roles", differences);
  compareExact(expected.warnings, actual.warnings, "/warnings", differences);
  if (expected.layers.length !== actual.layers.length) {
    addDifference(
      differences,
      "/layers/length",
      expected.layers.length,
      actual.layers.length,
    );
  }
  for (
    let index = 0;
    index < Math.min(expected.layers.length, actual.layers.length);
    index += 1
  ) {
    const left = expected.layers[index];
    const right = actual.layers[index];
    compareExact(
      left.declaredIndex,
      right.declaredIndex,
      `/layers/${index}/declaredIndex`,
      differences,
    );
    compareExact(
      left.extrusionTools,
      right.extrusionTools,
      `/layers/${index}/extrusionTools`,
      differences,
    );
    compareExact(
      left.tools,
      right.tools,
      `/layers/${index}/tools`,
      differences,
    );
    compareExact(
      left.roles,
      right.roles,
      `/layers/${index}/roles`,
      differences,
    );
    compareNumeric(
      left.z,
      right.z,
      `/layers/${index}/z`,
      differences,
      tolerances.layerZMm,
    );
  }
  for (const kind of ["bounds", "extrusionBounds"]) {
    for (const edge of ["min", "max"]) {
      for (const axis of ["x", "y", "z"]) {
        compareNumeric(
          expected[kind][edge][axis],
          actual[kind][edge][axis],
          `/${kind}/${edge}/${axis}`,
          differences,
          tolerances.boundsMm,
        );
      }
    }
  }
  compareNumeric(
    expected.extrusion.total,
    actual.extrusion.total,
    "/extrusion/total",
    differences,
    tolerances.extrusionAbsoluteMm,
    tolerances.extrusionRelative,
  );
  for (const key of ["byTool", "byRole", "byContext"]) {
    compareNumericRecord(
      expected.extrusion[key],
      actual.extrusion[key],
      `/extrusion/${key}`,
      differences,
      tolerances.extrusionAbsoluteMm,
      tolerances.extrusionRelative,
    );
  }
  if (expected.temperatures.length !== actual.temperatures.length) {
    addDifference(
      differences,
      "/temperatures/length",
      expected.temperatures.length,
      actual.temperatures.length,
    );
  }
  for (
    let index = 0;
    index < Math.min(expected.temperatures.length, actual.temperatures.length);
    index += 1
  ) {
    const left = expected.temperatures[index];
    const right = actual.temperatures[index];
    compareExact(
      { kind: left.kind, tool: left.tool, wait: left.wait },
      { kind: right.kind, tool: right.tool, wait: right.wait },
      `/temperatures/${index}/command`,
      differences,
    );
    compareNumeric(
      left.value,
      right.value,
      `/temperatures/${index}/value`,
      differences,
      tolerances.temperatureC,
    );
  }
  const estimateKeys = [
    ...new Set([
      ...Object.keys(expected.estimates),
      ...Object.keys(actual.estimates),
    ]),
  ].sort();
  for (const key of estimateKeys) {
    if (
      !Object.hasOwn(expected.estimates, key) ||
      !Object.hasOwn(actual.estimates, key)
    ) {
      addDifference(
        differences,
        `/estimates/${key}`,
        expected.estimates[key],
        actual.estimates[key],
      );
    } else {
      compareEstimate(
        expected.estimates[key],
        actual.estimates[key],
        `/estimates/${key}`,
        differences,
        tolerances,
      );
    }
  }
  return {
    actual,
    differences,
    equal: differences.length === 0,
    expected,
    tolerances,
  };
}

export function compareGcodeFiles(expectedPath, actualPath, options = {}) {
  return compareGcodeText(
    readFileSync(expectedPath, "utf8"),
    readFileSync(actualPath, "utf8"),
    options,
  );
}

export { DEFAULT_TOLERANCES };
