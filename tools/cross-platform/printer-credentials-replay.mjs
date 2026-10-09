// Remembered credentials through a binding: every stored record loads, and
// every record saves, as the browser's do. Runs unchanged over WASM in Node
// and a browser worker, and over the JNI bridge.
export function replayRememberedCredentials(core, fixture) {
  for (const [i, c] of fixture.loads.entries()) {
    const actual = core.credentials_load(c.stored ?? undefined);
    if (actual !== c.replyJson)
      throw Error(
        `loads ${i}: ${actual.slice(0, 400)} !== ${c.replyJson.slice(0, 400)}`,
      );
  }
  for (const [i, c] of fixture.saves.entries()) {
    const actual = core.credentials_save(c.requestJson) ?? null;
    if (actual !== c.stored)
      throw Error(
        `saves ${i}: ${String(actual).slice(0, 400)} !== ${String(c.stored).slice(0, 400)}`,
      );
  }
  return {
    rememberedCredentialsAnswers: [fixture.loads.length, fixture.saves.length],
  };
}
