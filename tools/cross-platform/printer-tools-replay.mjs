// Tool usage, filament slots and tool mapping through a binding: every
// artifact scanned in 4 KiB appends answers the browser's usage, and every
// slot reply and mapping the browser's answer. Runs unchanged over WASM in
// Node and a browser worker, and over the JNI bridge.
export function replayPrinterTools(core, fixture) {
  const eq = (actual, expected, label) => {
    if (actual !== expected) throw Error(`${label}: ${actual} !== ${expected}`);
  };
  const bytes = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  for (const entry of fixture.usage) {
    const data = bytes(entry.bytesBase64);
    const scanner = new core.ToolUsageScanner();
    try {
      for (let at = 0; at < data.length; at += 4096)
        scanner.append(data.subarray(at, at + 4096));
      eq(scanner.finish(), entry.usageJson, entry.name);
    } finally {
      scanner.free();
    }
  }
  for (const entry of fixture.slots)
    eq(core.filament_slots(entry.text), entry.replyJson, entry.name);
  for (const [i, entry] of fixture.mapping.entries())
    eq(core.tool_mapping(entry.requestJson), entry.replyJson, `mapping ${i}`);
  return {
    printerToolUsages: fixture.usage.length,
    printerSlotReplies: fixture.slots.length,
    printerMappings: fixture.mapping.length,
  };
}
