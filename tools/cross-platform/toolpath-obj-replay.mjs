// File → Export Toolpaths as OBJ… through the computation core's G-code
// session (`toolpath-obj-vectors.json`, from the browser's
// `exportToolpathsToObj`): each case's text streamed into a session whose own
// options would truncate its windows, sealed, and its OBJ written byte for
// byte (whole, or by SHA-256 and length) with the browser's segment count.
// Runs unchanged over WASM in Node and in a browser worker.
export async function replayToolpathObjs(GcodeSession, fixture, layout, sha256) {
  const fail = (label) => {
    throw Error(label);
  };
  const decoder = new TextDecoder();
  let segments = 0;
  for (const c of fixture.cases) {
    const text = c.source;
    const session = new GcodeSession(layout.version, text.length, '{"limits":{"records":1,"pathPoints":1}}');
    try {
      const chunk = new Uint16Array(Math.max(1, Math.min(text.length, layout.maxChunkUnits)));
      for (let offset = 0; offset < text.length; offset += chunk.length) {
        const count = Math.min(chunk.length, text.length - offset);
        for (let i = 0; i < count; i++) chunk[i] = text.charCodeAt(offset + i);
        session.append(offset, chunk.subarray(0, count));
      }
      session.seal();
      const bytes = session.toolpathObj();
      const obj = decoder.decode(bytes);
      if (c.obj !== undefined) {
        if (obj !== c.obj) fail(`${c.name}: not the browser's OBJ`);
      } else if (bytes.length !== c.bytes || (await sha256(bytes)) !== c.sha256) fail(`${c.name}: not the browser's OBJ`);
      const lines = obj.split("\n").filter((line) => line.startsWith("l ")).length;
      if (lines !== c.segments) fail(`${c.name}: ${lines} segments, not ${c.segments}`);
      segments += lines;
    } finally {
      session.free();
    }
  }
  return { toolpathObjAnswers: [fixture.cases.length, segments] };
}
