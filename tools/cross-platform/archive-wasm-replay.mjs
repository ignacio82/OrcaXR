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
  const counts = { cases: 0, openEnded: 0, accepted: 0, refused: 0, canonical: 0, foreign: 0, saves: 0, identical: 0, acknowledged: 0, saveRefusals: [] };
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
