// Compare host-decoded values with the independent UTF-16/Float32-bit corpus.
const units = (value) =>
  Array.from({ length: value.length }, (_, i) => value.charCodeAt(i));
export function packetSnapshot(value) {
  if (value instanceof Float32Array)
    return {
      $f32: Array.from(
        new Uint32Array(value.buffer, value.byteOffset, value.length),
      ),
    };
  if (ArrayBuffer.isView(value)) return Array.from(value);
  if (Array.isArray(value)) return value.map(packetSnapshot);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .map(([key, v]) => [
          key,
          key === "roles" && Array.isArray(v)
            ? v.map(units)
            : ["message", "color", "text", "layerTimeProvenance"].includes(
                  key,
                ) && typeof v === "string"
              ? units(v)
              : packetSnapshot(v),
        ]),
    );
  return value;
}
