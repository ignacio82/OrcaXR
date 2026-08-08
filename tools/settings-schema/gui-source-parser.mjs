import {
  findCalls,
  literalString,
  normalizedExpression,
  sourceLine,
  symbolAt,
} from "../parity/cpp-scan.mjs";

export const TAB_SOURCE_PATH = "src/slic3r/GUI/Tab.cpp";

const INVENTORY_BY_KIND = Object.freeze({
  page: "settingTabs",
  group: "settingGroups",
  option: "settingPlacements",
});

const CALLEE_BY_KIND = Object.freeze({
  page: "add_options_page",
  group: "new_optgroup",
  option: "append_single_option_line",
});

function displayExpression(expression) {
  return (
    literalString(expression) ?? `<runtime:${normalizedExpression(expression)}>`
  );
}

function guiSurface(symbol) {
  if (symbol.startsWith("TabPrintModel::")) return "object";
  if (symbol.startsWith("TabPrintPlate::")) return "plate";
  if (symbol.startsWith("TabPrint::")) return "process";
  if (symbol.startsWith("TabFilament::")) return "filament";
  if (symbol.startsWith("TabPrinter::")) return "printer";
  throw new Error(`Unsupported Tab.cpp settings symbol ${symbol}`);
}

function inventoryMap(manifest, family) {
  const entries = manifest?.inventory?.[family];
  if (!Array.isArray(entries))
    throw new Error(`Parity manifest has no ${family} inventory`);
  if (manifest?.counts?.[family] !== entries.length)
    throw new Error(
      `Parity manifest ${family} count mismatch: ${manifest?.counts?.[family]} != ${entries.length}`,
    );
  const byLine = new Map();
  for (const entry of entries) {
    const source = entry?.sources?.[0];
    if (entry?.family !== family)
      throw new Error(
        `Invalid ${family} family for ${entry?.id ?? "<missing-id>"}`,
      );
    if (typeof entry.id !== "string" || entry.id.length === 0)
      throw new Error(`Invalid ${family} id`);
    if (
      entry?.disposition?.id !== "P6.2" ||
      entry?.disposition?.kind !== "task" ||
      entry?.disposition?.rationale !== null
    )
      throw new Error(`Unexpected ${family} disposition for ${entry.id}`);
    if (!source || !Number.isInteger(source.line) || source.line < 1)
      throw new Error(`Invalid ${family} source for ${entry.id}`);
    if (byLine.has(source.line))
      throw new Error(`Duplicate ${family} source line ${source.line}`);
    byLine.set(source.line, entry);
  }
  return byLine;
}

function sourceReference(snapshot, manifest, source, call, symbol) {
  const blob = snapshot.blob(TAB_SOURCE_PATH);
  if (
    source.path !== TAB_SOURCE_PATH ||
    source.blob !== blob ||
    source.symbol !== symbol ||
    source.anchor !== sourceLine(snapshot.read(TAB_SOURCE_PATH), call.line)
  ) {
    throw new Error(`Stale ${TAB_SOURCE_PATH} provenance at line ${call.line}`);
  }
  return {
    anchor: source.anchor,
    blob,
    commit: manifest.upstream.commit,
    line: call.line,
    path: TAB_SOURCE_PATH,
    symbol,
    tree: manifest.upstream.tree,
  };
}

function eventInventory(snapshot, manifest, tabSource) {
  const inventory = Object.fromEntries(
    Object.values(INVENTORY_BY_KIND).map((family) => [
      family,
      inventoryMap(manifest, family),
    ]),
  );
  const events = Object.entries(CALLEE_BY_KIND)
    .flatMap(([kind, callee]) =>
      findCalls(tabSource, callee).map((call) => ({ kind, call })),
    )
    .sort((left, right) => left.call.start - right.call.start);

  const occurrence = new Map();
  const tabs = [];
  const groups = [];
  const placements = [];
  let currentSymbol = "";
  let currentTab = "<unscoped>";
  let currentGroup = "<unscoped>";

  for (const { kind, call } of events) {
    const symbol = symbolAt(tabSource, call.start);
    if (symbol !== currentSymbol) {
      currentSymbol = symbol;
      currentTab = "<unscoped>";
      currentGroup = "<unscoped>";
    }
    if (kind === "option" && literalString(call.args[0]) === null) continue;

    const family = INVENTORY_BY_KIND[kind];
    const entry = inventory[family].get(call.line);
    if (!entry)
      throw new Error(
        `Active ${CALLEE_BY_KIND[kind]} at ${TAB_SOURCE_PATH}:${call.line} is missing from ${family}`,
      );
    inventory[family].delete(call.line);
    const source = sourceReference(
      snapshot,
      manifest,
      entry.sources[0],
      call,
      symbol,
    );
    const surface = guiSurface(symbol);

    if (kind === "page") {
      currentTab = displayExpression(call.args[0]);
      currentGroup = "<unscoped>";
      const identity = `${symbol}\0${currentTab}`;
      const nth = (occurrence.get(identity) ?? 0) + 1;
      occurrence.set(identity, nth);
      if (
        entry.label !== currentTab ||
        entry.symbol !== symbol ||
        entry.occurrence !== nth
      )
        throw new Error(`Manifest tab mismatch for ${entry.id}`);
      const tab = {
        id: entry.id,
        label: currentTab,
        occurrence: nth,
        order: tabs.length,
        resolution: currentTab.startsWith("<runtime:") ? "runtime" : "literal",
        source,
        surface,
        symbol,
      };
      tabs.push(tab);
      continue;
    }

    if (kind === "group") {
      currentGroup = displayExpression(call.args[0]);
      const identity = `${symbol}\0${currentTab}\0${currentGroup}`;
      const nth = (occurrence.get(identity) ?? 0) + 1;
      occurrence.set(identity, nth);
      if (
        entry.label !== currentGroup ||
        entry.symbol !== symbol ||
        entry.tab !== currentTab ||
        entry.occurrence !== nth
      )
        throw new Error(`Manifest group mismatch for ${entry.id}`);
      const matchingTabs = tabs.filter(
        (tab) => tab.symbol === symbol && tab.label === currentTab,
      );
      if (matchingTabs.length !== 1)
        throw new Error(
          `Ambiguous tab binding for group ${entry.id}: found ${matchingTabs.length}`,
        );
      const group = {
        id: entry.id,
        label: currentGroup,
        occurrence: nth,
        order: groups.filter(
          (candidate) => candidate.tabId === matchingTabs[0].id,
        ).length,
        resolution: currentGroup.startsWith("<runtime:")
          ? "runtime"
          : "literal",
        source,
        surface,
        symbol,
        tabId: matchingTabs[0].id,
      };
      groups.push(group);
      continue;
    }

    const optionKey = literalString(call.args[0]);
    const identity = `${symbol}\0${currentTab}\0${currentGroup}\0${optionKey}`;
    const nth = (occurrence.get(identity) ?? 0) + 1;
    occurrence.set(identity, nth);
    if (
      entry.label !== optionKey ||
      entry.optionKey !== optionKey ||
      entry.symbol !== symbol ||
      entry.tab !== currentTab ||
      entry.group !== currentGroup ||
      entry.occurrence !== nth
    )
      throw new Error(`Manifest placement mismatch for ${entry.id}`);
    const matchingGroups = groups.filter(
      (group) =>
        group.symbol === symbol &&
        tabs.find((tab) => tab.id === group.tabId)?.label === currentTab &&
        group.label === currentGroup,
    );
    if (matchingGroups.length !== 1)
      throw new Error(
        `Ambiguous group binding for placement ${entry.id}: found ${matchingGroups.length}`,
      );
    const group = matchingGroups[0];
    placements.push({
      groupId: group.id,
      id: entry.id,
      occurrence: nth,
      optionKey,
      order: placements.filter((candidate) => candidate.groupId === group.id)
        .length,
      source,
      surface,
      symbol,
      tabId: group.tabId,
    });
  }

  for (const [family, remaining] of Object.entries(inventory)) {
    if (remaining.size > 0) {
      const [line, entry] = remaining.entries().next().value;
      throw new Error(
        `Manifest ${family} entry ${entry.id} at ${TAB_SOURCE_PATH}:${line} is missing from active source`,
      );
    }
  }

  return { groups, placements, tabs };
}

function unresolvedCall(tabSource, snapshot, manifest, call, kind, expression) {
  const symbol = symbolAt(tabSource, call.start);
  return {
    expression: normalizedExpression(expression),
    kind,
    source: {
      anchor: sourceLine(tabSource, call.line),
      blob: snapshot.blob(TAB_SOURCE_PATH),
      commit: manifest.upstream.commit,
      line: call.line,
      path: TAB_SOURCE_PATH,
      symbol,
      tree: manifest.upstream.tree,
    },
    status: "unresolved-fail-closed",
  };
}

function unresolvedCalls(tabSource, snapshot, manifest) {
  const dynamicPlacements = findCalls(tabSource, "append_single_option_line")
    .filter((call) => literalString(call.args[0]) === null)
    .map((call) =>
      unresolvedCall(
        tabSource,
        snapshot,
        manifest,
        call,
        "dynamic-option-key",
        call.args[0],
      ),
    );
  const specialWidgets = findCalls(tabSource, "create_line_with_widget").map(
    (call) => ({
      ...unresolvedCall(
        tabSource,
        snapshot,
        manifest,
        call,
        "custom-widget",
        call.args[1],
      ),
      optionKey: literalString(call.args[1]),
    }),
  );
  if (specialWidgets.some((item) => item.optionKey === null))
    throw new Error(
      "Dynamic create_line_with_widget option keys are unsupported",
    );
  return { dynamicPlacements, specialWidgets };
}

function projectConfigWrites(tabSource, snapshot, manifest) {
  return findCalls(tabSource, "set_project_bool").map((call) => {
    const optionKey = literalString(call.args[0]);
    if (optionKey === null)
      throw new Error(
        `Dynamic set_project_bool key at ${TAB_SOURCE_PATH}:${call.line}`,
      );
    const symbol = symbolAt(tabSource, call.start);
    return {
      optionKey,
      source: {
        anchor: sourceLine(tabSource, call.line),
        blob: snapshot.blob(TAB_SOURCE_PATH),
        commit: manifest.upstream.commit,
        line: call.line,
        path: TAB_SOURCE_PATH,
        symbol,
        tree: manifest.upstream.tree,
      },
      status: "exact-project-config-write",
    };
  });
}

export function extractGuiLayout({
  snapshot,
  manifest,
  allowSyntheticSource = false,
}) {
  const tabSource = snapshot.read(TAB_SOURCE_PATH);
  const manifestBlob = manifest.sourceFiles.find(
    (file) => file.path === TAB_SOURCE_PATH,
  )?.blob;
  if (!allowSyntheticSource && manifestBlob !== snapshot.blob(TAB_SOURCE_PATH))
    throw new Error(`Manifest/source blob mismatch for ${TAB_SOURCE_PATH}`);
  const { groups, placements, tabs } = eventInventory(
    snapshot,
    manifest,
    tabSource,
  );
  const unresolved = unresolvedCalls(tabSource, snapshot, manifest);
  const exactProjectConfigWrites = projectConfigWrites(
    tabSource,
    snapshot,
    manifest,
  );
  return {
    coverage: {
      dynamicPlacements: unresolved.dynamicPlacements.length,
      groups: groups.length,
      literalPlacements: placements.length,
      projectConfigWrites: exactProjectConfigWrites.length,
      specialWidgets: unresolved.specialWidgets.length,
      tabs: tabs.length,
      uniqueLiteralPlacementKeys: new Set(
        placements.map((placement) => placement.optionKey),
      ).size,
    },
    groups,
    placements,
    semanticDispositions: {
      dependencies: {
        reason:
          "Tab.cpp dependency predicates are imperative and are not represented by the literal placement inventory.",
        status: "unresolved-unenforced",
      },
      resetRules: {
        reason:
          "Per-control upstream reset rules are not proven by the literal placement inventory.",
        status: "unresolved-unenforced",
      },
      scopes: {
        reason:
          "Exact Tab.cpp project-config writes are enumerated, but general object, part, layer-range, and plate override eligibility requires separate authority.",
        status: "unresolved-fail-closed",
      },
    },
    scopeEvidence: {
      projectConfigWrites: exactProjectConfigWrites,
    },
    source: {
      blob: snapshot.blob(TAB_SOURCE_PATH),
      commit: manifest.upstream.commit,
      path: TAB_SOURCE_PATH,
      tree: manifest.upstream.tree,
    },
    status: "manifest-literal-partial",
    tabs,
    unresolved,
  };
}
