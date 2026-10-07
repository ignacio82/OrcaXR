// Executed inside the real browser task worker. Expectations come from the
// production TypeScript GcodeDocument, never from another Rust binding.
export async function replayDocuments(GcodeSession) {
  const corpus = await (await fetch('/gcode-document-vectors.json')).json();
  const layout = await (await fetch('/gcode-buffer.json')).json();
  const check = (ok, label) => { if (!ok) throw new Error(label); };
  const units = (value) => typeof value === 'string'
    ? Array.from({ length: value.length }, (_, i) => value.charCodeAt(i))
    : value;
  const number = (value) => typeof value === 'number' ? value : Number(value);
  let windows = 0, searches = 0;
  for (const row of corpus.cases) {
    const source = units(row.source);
    const session = new GcodeSession(layout.version, source.length, '{}');
    try {
      // Odd chunks split surrogate pairs and lines across appends.
      for (let offset = 0; offset < source.length; offset += 4093)
        session.append(offset, new Uint16Array(source.slice(offset, offset + 4093)));
      session.seal();
      for (const window of row.windows) {
        const reply = JSON.parse(session.textWindow(number(window.from), number(window.count)));
        check(reply.lineCount === row.lineCount, `${row.name}: lineCount`);
        check(reply.lines.length === window.lines.length, `${row.name}: window size`);
        reply.lines.forEach((line, i) => {
          check(line.number === window.lines[i].number, `${row.name}: line number`);
          check(JSON.stringify(line.text) === JSON.stringify(units(window.lines[i].text)), `${row.name}: line ${line.number}`);
        });
        windows++;
      }
      for (const search of row.searches) {
        const reply = JSON.parse(session.textSearch(new Uint16Array(units(search.query)), search.limit));
        check(JSON.stringify(reply.lineNumbers) === JSON.stringify(search.lineNumbers), `${row.name}: search`);
        check(reply.truncated === search.truncated, `${row.name}: truncated`);
        searches++;
      }
      // One line past the window bound is refused only when that many lines exist.
      let error;
      try { session.textWindow(1, layout.maxTextWindowLines + 1); } catch (thrown) { error = String(thrown); }
      check(row.lineCount > layout.maxTextWindowLines ? error === 'resource_limit' : error === undefined,
        `${row.name}: window bound`);
    } finally { session.free(); }
  }
  return { sources: corpus.cases.length, windows, searches };
}
