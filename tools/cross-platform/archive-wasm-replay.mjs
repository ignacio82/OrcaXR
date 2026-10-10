// Archive Open/Save through the actual project WASM binding. Runs unchanged in
// Node and a browser worker. Expectations are the production browser's Open
// results (canonical-complete and foreign-import corpora), never Rust output.
const EMPTY = JSON.stringify({
  activePlateId: "import:archive-replay:plate",
  config: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  customGcode: [],
  extensionBlobs: [],
  filaments: { mixed: [], physical: [] },
  id: "import:archive-replay:project",
  name: "Empty",
  plates: [
    { config: {}, id: "import:archive-replay:plate", name: "Plate 1", objects: [], order: 0, printable: true },
  ],
  printer: { toolCount: 1 },
  schemaVersion: 1,
  sourceAssets: [],
  thumbnails: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
});

/** Browser-equivalent budgets: the safe-ZIP defaults and multi-million facets. */
export const BROWSER_EQUIVALENT_POLICY = [
  2 ** 30, 4096, 512 * 2 ** 20, 2 ** 31, 16_000_000, 16_000_000, 2_000_000, 64 * 2 ** 20, 256_000_000, 4096,
  512 * 2 ** 20, 2 ** 31, 1_000_000,
];

/**
 * The only Saves the production browser also refuses: canonical envelopes whose
 * plate origins cannot be projected into BBS build coordinates.
 */
export const ARCHIVE_SAVE_REFUSALS = [
  "canonical/unresolved-plate-origin: unsavable_project",
  "canonical/unresolved-origin-svg-valid.svg: unsavable_project",
];

export async function replayArchives(core, hostLayout, archiveLayout, cases, sha256) {
  const encode = new TextEncoder();
  const decode = new TextDecoder("utf-8", { fatal: true });
  const policy = Float64Array.from(BROWSER_EQUIVALENT_POLICY);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
  };
  const units = (text) => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
  const sameUnits = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);
  const hostOptions = (bytes) =>
    Float64Array.from([bytes, 1_000_000, 2_000_000, 1024, 128, 100, 16 * 2 ** 20, 32 * 2 ** 20, 100, 32 * 2 ** 20]);
  const session = () => {
    const source = encode.encode(EMPTY);
    const upload = new core.ProjectUpload(hostLayout.version, source.length, hostOptions(source.length));
    upload.append_document(0, source);
    upload.seal_document();
    return upload.open(Float64Array.from([0, 1, 2, 3]));
  };
  const read = (output) => {
    const bytes = new Uint8Array(output.length());
    for (let p = 0; p < bytes.length; p += archiveLayout.maxChunkBytes)
      bytes.set(output.read(p, Math.min(archiveLayout.maxChunkBytes, bytes.length - p)), p);
    return bytes;
  };
  const warnings = (owner) =>
    Array.from({ length: owner.warning_count() }, (_, i) => {
      const length = owner.warning_length(i);
      const out = [];
      for (let p = 0; p < length; p += hostLayout.maxTextChunkUnits)
        out.push(...owner.warning(i, p, Math.min(hostLayout.maxTextChunkUnits, length - p)));
      return out;
    });
  const state = (owner) => {
    const capture = owner.snapshot();
    try {
      const exported = capture.export_json(512 * 2 ** 20);
      try {
        const bytes = new Uint8Array(exported.length());
        for (let p = 0; p < bytes.length; p += hostLayout.maxChunkBytes)
          bytes.set(exported.read(p, Math.min(hostLayout.maxChunkBytes, bytes.length - p)), p);
        return decode.decode(bytes);
      } finally {
        exported.free();
      }
    } finally {
      capture.free();
    }
  };
  // Declared-length and open-ended (unsized provider) staging must agree.
  const open = (bytes, exact = true) => {
    const upload = new core.ProjectArchiveUpload(archiveLayout.version, exact ? bytes.length : undefined, policy);
    for (let p = 0; p < bytes.length; p += archiveLayout.maxChunkBytes)
      upload.append(p, bytes.subarray(p, p + archiveLayout.maxChunkBytes));
    return upload.prepare();
  };
  const adopt = (owner, imported) => {
    const ticket = owner.begin_open();
    const document = imported.document();
    try {
      owner.finish_open(ticket, document).free();
    } finally {
      document.free();
      ticket.free();
    }
  };
  const projectJson = (capture) => {
    const exported = capture.export_json(512 * 2 ** 20);
    try {
      const bytes = new Uint8Array(exported.length());
      for (let p = 0; p < bytes.length; p += hostLayout.maxChunkBytes)
        bytes.set(exported.read(p, Math.min(hostLayout.maxChunkBytes, bytes.length - p)), p);
      return decode.decode(bytes);
    } finally {
      exported.free();
    }
  };
  // Each plate as the archive an external slicer loads: the session's export
  // capture projects it as the state-document exchange does (within that
  // exchange's bound) with the same overrides, and the first printable
  // plate's archive reopens to that one plate with exactly its assets.
  const MAX_EXCHANGE_BYTES = 2 ** 20;
  const plateArchives = (name, owner, json) => {
    const parsed = JSON.parse(json);
    const exchange = encode.encode(json).length <= MAX_EXCHANGE_BYTES;
    const guard = owner.capture_guard();
    let capture;
    try {
      capture = owner.capture_export(guard);
    } finally {
      guard.free();
    }
    try {
      let written = false;
      for (const plate of parsed.plates) {
        const id = JSON.stringify(plate.id);
        const expected = exchange ? JSON.parse(core.plate_projection(json, id, "[]")) : undefined;
        let projected;
        try {
          projected = capture.plate(id);
        } catch (error) {
          check(!plate.printable && String(error) === "plate_projection_not_printable", `${name}: plate refused (${error})`);
          check(!expected || expected.error === "plate_projection_not_printable", `${name}: plate exchange accepted a refusal`);
          counts.plateRefusals++;
          continue;
        }
        try {
          const project = projected.project();
          let projectedJson;
          try {
            projectedJson = projectJson(project);
            check(JSON.parse(projectedJson).plates.length === 1, `${name}: one plate`);
            if (expected) {
              check(project.hash() === expected.sourceHash, `${name}: plate hash`);
              check(projectedJson === expected.stateJson, `${name}: plate state`);
              check(project.plate_print_overrides(id) === core.plate_print_overrides(json, id), `${name}: plate overrides`);
              counts.plateExchanges++;
            }
          } finally {
            project.free();
          }
          counts.plates++;
          if (written) continue;
          written = true;
          let output;
          try {
            output = projected.write_archive(archiveLayout.version, policy);
          } catch (error) {
            // The plate inherits whatever makes its project unsavable.
            counts.plateArchiveRefusals.push(`${name}: ${error}`);
            continue;
          }
          let bytes;
          try {
            bytes = read(output);
          } finally {
            output.free();
          }
          const reopened = open(bytes);
          const second = session();
          try {
            adopt(second, reopened);
            const after = JSON.parse(state(second));
            const before = JSON.parse(projectedJson);
            check(after.plates.length === 1 && after.plates[0].id === plate.id, `${name}: plate archive plate`);
            check(after.activePlateId === plate.id, `${name}: plate archive active plate`);
            check(
              JSON.stringify(after.sourceAssets) === JSON.stringify(before.sourceAssets),
              `${name}: plate archive assets`,
            );
            counts.plateArchives++;
          } finally {
            reopened.free();
            second.free();
          }
        } finally {
          projected.free();
        }
      }
    } finally {
      capture.free();
    }
  };
  const counts = {
    cases: 0, openEnded: 0, accepted: 0, refused: 0, canonical: 0, foreign: 0, saves: 0, identical: 0, acknowledged: 0, saveRefusals: [],
    plates: 0, plateRefusals: 0, plateExchanges: 0, plateArchives: 0, plateArchiveRefusals: [],
  };
  for (const c of cases) {
    const exact = counts.cases++ % 2 === 0;
    if (!exact) counts.openEnded++;
    let imported;
    try {
      imported = open(c.bytes, exact);
    } catch (error) {
      check(!c.accepted, `${c.name}: binding refused (${error})`);
      counts.refused++;
      continue;
    }
    const owner = session();
    try {
      check(c.accepted, `${c.name}: binding accepted a browser refusal`);
      check(imported.format() === archiveLayout.formats.indexOf(c.format), `${c.name}: format`);
      const actual = warnings(imported);
      check(
        actual.length === c.warnings.length && actual.every((w, i) => sameUnits(w, c.warnings[i])),
        `${c.name}: warnings`,
      );
      adopt(owner, imported);
      const json = state(owner);
      check(c.stateJson ? json === c.stateJson : (await sha256(encode.encode(json))) === c.stateSha256, `${c.name}: state`);
      counts[c.format]++;
      counts.accepted++;
      plateArchives(c.name, owner, json);
      // Save the adopted project, then reopen those exact bytes in a new session.
      let output;
      try {
        output = owner.write_archive(archiveLayout.version, policy);
      } catch (error) {
        // The browser refuses the same Saves (unresolvable plate origins and a
        // preserved model-settings collision); the session stays dirty.
        counts.saveRefusals.push(`${c.name}: ${error}`);
        continue;
      }
      let saved;
      try {
        saved = read(output);
        const guard = output.guard();
        try {
          owner.acknowledge_checkpoint(guard).free();
          const history = owner.history();
          try {
            check(history.dirty_categories() === "", `${c.name}: checkpoint`);
          } finally {
            history.free();
          }
          counts.acknowledged++;
        } finally {
          guard.free();
        }
      } finally {
        output.free();
      }
      const reopened = open(saved);
      const second = session();
      try {
        check(reopened.format() === 0, `${c.name}: Save writes the canonical envelope`);
        adopt(second, reopened);
        // Save may add preserved members on reopen (for example a drawing beside
        // a preserved original model_settings.config), so the contract is that
        // plates and every declared asset survive; exact equality is counted.
        const after = state(second);
        const a = JSON.parse(json),
          b = JSON.parse(after);
        check(JSON.stringify(a.plates) === JSON.stringify(b.plates), `${c.name}: Save keeps plates`);
        const kept = new Set(b.sourceAssets.map((d) => JSON.stringify(d)));
        check(a.sourceAssets.every((d) => kept.has(JSON.stringify(d))), `${c.name}: Save keeps assets`);
        if (after === json) counts.identical++;
        counts.saves++;
      } finally {
        reopened.free();
        second.free();
      }
    } finally {
      imported.free();
      owner.free();
    }
  }
  // Malformed uploads are refused before any import work.
  const refuses = (fn, label) => {
    try {
      fn();
    } catch {
      return;
    }
    throw new Error(label);
  };
  refuses(() => new core.ProjectArchiveUpload(archiveLayout.version + 1, 10, policy), "version");
  refuses(() => new core.ProjectArchiveUpload(archiveLayout.version, policy[0] + 1, policy), "archive budget");
  refuses(() => new core.ProjectArchiveUpload(archiveLayout.version, 10, policy.subarray(1)), "policy shape");
  const partial = new core.ProjectArchiveUpload(archiveLayout.version, 10, policy);
  refuses(() => partial.append(1, new Uint8Array(1)), "out-of-order chunk");
  refuses(() => partial.append(0, new Uint8Array(11)), "oversized chunk");
  partial.append(0, new Uint8Array(4));
  refuses(() => partial.prepare(), "incomplete archive");
  const tight = Float64Array.from(policy);
  tight[0] = 4;
  refuses(() => new core.ProjectArchiveUpload(archiveLayout.version, undefined, tight).prepare(), "empty open-ended archive");
  const unsized = new core.ProjectArchiveUpload(archiveLayout.version, undefined, tight);
  unsized.append(0, new Uint8Array(4));
  refuses(() => unsized.append(4, new Uint8Array(1)), "open-ended archive budget");
  refuses(() => unsized.prepare(), "open-ended non-archive");
  check(
    JSON.stringify(counts.saveRefusals) === JSON.stringify(ARCHIVE_SAVE_REFUSALS) &&
      counts.saves + counts.saveRefusals.length === counts.accepted &&
      counts.acknowledged === counts.saves &&
      counts.accepted + counts.refused === cases.length,
    `archive totals ${JSON.stringify(counts)}`,
  );
  return counts;
}

/** Corpus rows: canonical-complete and foreign-import expectations. */
export function archiveCases(canonical, foreign, readPath, base64) {
  const out = [];
  for (const c of canonical.cases) {
    const bytes = Uint8Array.from(c.archiveHex.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
    out.push({
      name: `canonical/${c.name}`,
      bytes,
      accepted: c.expected !== null,
      format: "canonical",
      ...(c.expected ? { stateJson: c.expected.stateJson, warnings: c.expected.warnings } : {}),
    });
  }
  for (const c of foreign.cases) {
    const bytes = c.archiveBase64 ? base64(c.archiveBase64) : readPath(c.archivePath);
    const e = c.expected;
    out.push({
      name: `foreign/${c.name}`,
      bytes,
      accepted: e.accepted,
      format: "foreign",
      ...(e.accepted
        ? {
            ...(e.stateJson ? { stateJson: e.stateJson } : { stateSha256: e.stateSha256 }),
            warnings: e.warnings.map((w) => (typeof w === "string" ? Array.from({ length: w.length }, (_, i) => w.charCodeAt(i)) : w)),
          }
        : {}),
    });
  }
  return out;
}

/**
 * Deterministic byte edits of a base archive, shared with the hostile-archive
 * generator so a mutated case is stored as its edits rather than its bytes.
 * Each edit applies to the result of the ones before it.
 */
export function applyArchiveEdits(base, edits) {
  let bytes = Array.from(base);
  for (const edit of edits) {
    if ("flip" in edit) {
      const [at, bit] = edit.flip;
      if (at < bytes.length) bytes[at] ^= 1 << bit;
    } else if ("set" in edit) {
      const [at, value] = edit.set;
      if (at < bytes.length) bytes[at] = value;
    } else if ("truncate" in edit) {
      bytes = bytes.slice(0, edit.truncate);
    } else if ("insert" in edit) {
      const [at, inserted] = edit.insert;
      bytes.splice(Math.min(at, bytes.length), 0, ...inserted);
    } else if ("remove" in edit) {
      const [at, count] = edit.remove;
      bytes.splice(at, count);
    } else {
      throw new Error(`unknown archive edit ${JSON.stringify(edit)}`);
    }
  }
  return Uint8Array.from(bytes);
}

/**
 * Hostile archives (`hostile-archive-vectors.json`) through the binding:
 * each is refused exactly when the browser refused it, and an accepted one
 * reports the browser's format and warnings and adopts to the browser's
 * state. A refusal never reaches a session: an edited live session keeps its
 * revision and hash across every refused Open.
 */
export async function replayHostileArchives(core, hostLayout, archiveLayout, corpus, sha256, base64) {
  const encode = new TextEncoder();
  const decode = new TextDecoder("utf-8", { fatal: true });
  const policy = Float64Array.from(BROWSER_EQUIVALENT_POLICY);
  const check = (ok, label) => {
    if (!ok) throw new Error(label);
  };
  const units = (text) => (typeof text === "string" ? Array.from({ length: text.length }, (_, i) => text.charCodeAt(i)) : text);
  const sameUnits = (a, b) => a.length === b.length && a.every((u, i) => u === b[i]);
  const generation = [0, 1, 2, 3];
  const session = () => {
    const source = encode.encode(EMPTY);
    const upload = new core.ProjectUpload(
      hostLayout.version,
      source.length,
      Float64Array.from([source.length, 1_000_000, 2_000_000, 1024, 128, 100, 16 * 2 ** 20, 32 * 2 ** 20, 100, 32 * 2 ** 20]),
    );
    upload.append_document(0, source);
    upload.seal_document();
    return upload.open(Float64Array.from(generation));
  };
  let sequence = 0;
  const submit = (owner, operation) => {
    const reply =
      owner.submit(JSON.stringify({ protocolVersion: 1, generation, requestId: ++sequence, operation })) ?? owner.run_next();
    return JSON.parse(reply.wire()).result;
  };
  const mark = (owner) => {
    const snapshot = owner.snapshot();
    try {
      return `${snapshot.revision()}:${snapshot.hash()}`;
    } finally {
      snapshot.free();
    }
  };
  const live = session();
  const counts = { cases: 0, accepted: 0, refused: 0, untouched: 0 };
  try {
    check(submit(live, { hello: { minProtocolVersion: 1, maxProtocolVersion: 1, projectSchemaVersion: 1, intentVersion: 1 } }).welcome, "hello");
    const guard = submit(live, { query: {} }).acknowledged.guard;
    const renamed = submit(live, {
      execute: { guard, intent: { version: 1, command: { renameProject: { name: units("Edited before hostile Opens") } } } },
    });
    check(renamed.acknowledged?.changed === true, "the live session is edited");
    const edited = mark(live);
    for (const c of corpus.cases) {
      counts.cases++;
      const bytes = c.archiveBase64
        ? base64(c.archiveBase64)
        : applyArchiveEdits(base64(corpus.bases[c.base].archiveBase64), c.edits);
      let imported;
      try {
        const upload = new core.ProjectArchiveUpload(archiveLayout.version, bytes.length, policy);
        for (let p = 0; p < bytes.length; p += archiveLayout.maxChunkBytes)
          upload.append(p, bytes.subarray(p, p + archiveLayout.maxChunkBytes));
        imported = upload.prepare();
      } catch (error) {
        check(!c.expected.accepted, `${c.name}: binding refused (${error})`);
        check(mark(live) === edited, `${c.name}: a refused Open changed the live session`);
        counts.refused++;
        counts.untouched++;
        continue;
      }
      const owner = session();
      try {
        check(c.expected.accepted, `${c.name}: binding accepted a browser refusal`);
        check(imported.format() === archiveLayout.formats.indexOf(c.expected.format), `${c.name}: format`);
        const warnings = Array.from({ length: imported.warning_count() }, (_, i) => {
          const length = imported.warning_length(i);
          const out = [];
          for (let p = 0; p < length; p += hostLayout.maxTextChunkUnits)
            out.push(...imported.warning(i, p, Math.min(hostLayout.maxTextChunkUnits, length - p)));
          return out;
        });
        const expected = c.expected.warnings.map(units);
        check(warnings.length === expected.length && warnings.every((w, i) => sameUnits(w, expected[i])), `${c.name}: warnings`);
        const ticket = owner.begin_open();
        const document = imported.document();
        try {
          owner.finish_open(ticket, document).free();
        } finally {
          document.free();
          ticket.free();
        }
        const capture = owner.snapshot();
        let json;
        try {
          const exported = capture.export_json(512 * 2 ** 20);
          try {
            const out = new Uint8Array(exported.length());
            for (let p = 0; p < out.length; p += hostLayout.maxChunkBytes)
              out.set(exported.read(p, Math.min(hostLayout.maxChunkBytes, out.length - p)), p);
            json = decode.decode(out);
          } finally {
            exported.free();
          }
        } finally {
          capture.free();
        }
        check((await sha256(encode.encode(json))) === c.expected.stateSha256, `${c.name}: state`);
        counts.accepted++;
      } finally {
        imported.free();
        owner.free();
      }
    }
  } finally {
    live.free();
  }
  return {
    hostileArchives: counts.cases,
    hostileAccepted: counts.accepted,
    hostileRefused: counts.refused,
    hostileUntouched: counts.untouched,
  };
}
