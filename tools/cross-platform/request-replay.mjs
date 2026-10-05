// Run the independent request vectors through actual WASM inside an owned worker.
export async function replayRequests(GcodeSession) {
  const corpus = await (await fetch('/request-vectors.json')).json();
  const source = Uint16Array.from({ length: corpus.source.length }, (_, i) => corpus.source.charCodeAt(i));
  const owner = new GcodeSession(1, source.length, '{}');
  try {
    owner.append(0, source); owner.seal();
    for (const vector of corpus.vectors) {
      let result = 'ok';
      try {
        if (vector.kind === 'Options') new GcodeSession(1, 0, vector.json).free();
        else owner.view(vector.json);
      } catch (error) { result = String(error); }
      if (result !== vector.result) throw new Error(`Request contract mismatch: ${vector.id}: ${result}`);
    }
    // Prior refusals must not leave stale pending state or poison the owner.
    owner.view('{"version":1,"operation":"inspection","window":[],"request":{}}');
    return { cases: corpus.vectors.length, validAfterRejection: true };
  } finally { owner.free(); }
}
