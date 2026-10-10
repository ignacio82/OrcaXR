// Executed inside the real browser task worker. Expectations come from the
// production TypeScript GcodeArtifactSummary, never from another Rust binding:
// each artifact decoded as the browser decodes it, sealed in the shared core's
// session and stated through the contract's decoder.
import { decodeGcodeSummary } from '/gcode-packets.mjs';
export async function replaySummaries(GcodeSession) {
  const corpus = await (await fetch('/gcode-summary-vectors.json')).json();
  const layout = await (await fetch('/gcode-buffer.json')).json();
  const check = (ok, label) => { if (!ok) throw new Error(label); };
  // Pieces are joined without spreading a large array into arguments.
  const bytes = (parts) => {
    const encoder = new TextEncoder();
    const pieces = [];
    for (const part of parts) {
      if (typeof part.text === 'string') pieces.push(encoder.encode(part.text));
      else if (typeof part.repeat === 'string') pieces.push(encoder.encode(part.repeat.repeat(part.times)));
      else if (Array.isArray(part.repeatBytes)) for (let i = 0; i < part.times; i++) pieces.push(Uint8Array.from(part.repeatBytes));
      else pieces.push(Uint8Array.from(part.bytes));
    }
    const out = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
    let offset = 0;
    for (const piece of pieces) {
      out.set(piece, offset);
      offset += piece.length;
    }
    return out;
  };
  // The corpus writes numbers as JavaScript does, keeping -0.
  const js = (value) => (Object.is(value, -0) ? '-0' : String(value));
  const same = (actual, expected, path) => {
    if (expected && typeof expected === 'object') {
      check(actual && typeof actual === 'object' && Array.isArray(actual) === Array.isArray(expected), path);
      check(JSON.stringify(Object.keys(actual).sort()) === JSON.stringify(Object.keys(expected).sort()), `${path}: keys`);
      for (const key of Object.keys(expected)) same(actual[key], expected[key], `${path}.${key}`);
    } else if (typeof expected === 'string' && typeof actual === 'number') check(js(actual) === expected, `${path}: ${js(actual)}`);
    else check(actual === expected, `${path}: ${actual}`);
  };
  let tools = 0;
  for (const row of corpus.cases) {
    const text = new TextDecoder().decode(bytes(row.parts));
    const session = new GcodeSession(layout.version, text.length, '{}');
    try {
      const chunk = new Uint16Array(Math.min(text.length, layout.maxChunkUnits));
      for (let offset = 0; offset < text.length; offset += chunk.length) {
        const count = Math.min(chunk.length, text.length - offset);
        for (let i = 0; i < count; i++) chunk[i] = text.charCodeAt(offset + i);
        session.append(offset, chunk.subarray(0, count));
      }
      session.seal();
      const { summary, text: description } = decodeGcodeSummary(session.summary());
      same(summary, row.summary, `${row.name}: summary`);
      same(description, row.description, `${row.name}: description`);
      tools += summary.perTool.length;
    } finally {
      session.free();
    }
  }
  return { cases: corpus.cases.length, tools };
}
