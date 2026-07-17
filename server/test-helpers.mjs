import { deflateRawSync } from "node:zlib";

function localHeader({ name, method, compressedSize, uncompressedSize }) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(method, 8);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(compressedSize, 18);
  header.writeUInt32LE(uncompressedSize, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  return { header, nameBytes };
}

function centralHeader({
  name,
  method,
  compressedSize,
  uncompressedSize,
  offset,
  externalAttributes = 0,
}) {
  const nameBytes = Buffer.from(name);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(method, 10);
  header.writeUInt32LE(0, 16);
  header.writeUInt32LE(compressedSize, 20);
  header.writeUInt32LE(uncompressedSize, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt32LE(externalAttributes >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  return { header, nameBytes };
}

export function buildZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const source = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "");
    const method = entry.method ?? 0;
    const compressed =
      entry.compressedData ?? (method === 8 ? deflateRawSync(source) : source);
    const declaredCompressed = entry.declaredCompressed ?? compressed.length;
    const declaredUncompressed = entry.declaredUncompressed ?? source.length;
    const local = localHeader({
      name: entry.name,
      method,
      compressedSize: declaredCompressed,
      uncompressedSize: declaredUncompressed,
    });
    localParts.push(local.header, local.nameBytes, compressed);
    const central = centralHeader({
      name: entry.name,
      method,
      compressedSize: declaredCompressed,
      uncompressedSize: declaredUncompressed,
      offset,
      externalAttributes: entry.externalAttributes,
    });
    centralParts.push(central.header, central.nameBytes);
    offset += local.header.length + local.nameBytes.length + compressed.length;
  }
  const central = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, central, eocd]);
}

export function valid3mf(extraEntries = []) {
  return buildZip([
    { name: "[Content_Types].xml", data: "<Types />", method: 8 },
    { name: "3D/3dmodel.model", data: "<model />", method: 8 },
    ...extraEntries,
  ]);
}

export function modelForm(
  data = Buffer.from("solid model\nendsolid model\n"),
  overrides = "{}",
  filename = "model.stl",
) {
  const form = new FormData();
  form.append("file", new Blob([data]), filename);
  if (overrides !== null) form.append("overrides", overrides);
  return form;
}
