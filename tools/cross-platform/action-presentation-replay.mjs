// How the shells arrange catalogue actions through a binding
// (`action-presentation-vectors.json`): every palette search over every
// language's catalogue and the edge cases, every context menu's sections and
// toolbar's runs, compared byte for byte with the browser's replies, and every
// malformed request refused. Runs unchanged over WASM in Node and over the JNI
// bridge.
export function replayActionPresentation(core, fixture) {
  const fail = (label) => {
    throw Error(label);
  };
  const exchanges = {
    palette: (r) => core.command_palette(r),
    groups: (r) => core.action_groups(r),
  };
  const counts = { paletteSearches: 0, actionArrangements: 0, presentationRefusals: 0 };
  for (const c of fixture.palette) {
    const request = `{"actions":${fixture.catalogues[c.catalogue].actions},"query":${c.query}}`;
    if (exchanges.palette(request) !== c.reply) fail(`palette ${c.query}: reply differs`);
    counts.paletteSearches++;
  }
  for (const c of fixture.groups) {
    if (exchanges.groups(c.request) !== c.reply) fail(`groups ${c.request}: reply differs`);
    counts.actionArrangements++;
  }
  for (const r of fixture.refusals) {
    let refused = false;
    try {
      exchanges[r.exchange](r.request);
    } catch (e) {
      if (!String(e?.message ?? e).includes("invalid_request")) throw e;
      refused = true;
    }
    if (!refused) fail(`${r.exchange} refusal ${r.request} was accepted`);
    counts.presentationRefusals++;
  }
  return counts;
}
