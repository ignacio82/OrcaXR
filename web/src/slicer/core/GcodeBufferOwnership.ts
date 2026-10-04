import { GCODE_FIELDS, GCODE_LAYOUT } from '../../../../contracts/generated/gcode-layout';
import type { RichGcodeModel } from '../RichGcodeModel';

/** Main-thread transfer check after the worker's full decoder. Every column
 * must name its exact checked range in one complete owned packet. Merely
 * relaxing each column's backing-buffer cap would accept excess allocations. */
export function hasPackedGcodeOwnership(model: RichGcodeModel): boolean {
  const buffer = model.columns.kind?.buffer;
  if (
    !(buffer instanceof ArrayBuffer) ||
    buffer.byteLength < 24 ||
    buffer.byteLength > GCODE_LAYOUT.maxPacketBytes ||
    ('resizable' in buffer && buffer.resizable)
  )
    return false;
  const data = new DataView(buffer);
  const metadata = data.getUint32(8, true),
    records = data.getUint32(12, true),
    points = data.getUint32(16, true);
  if (
    data.getUint32(0, true) !== 0x5047584f ||
    data.getUint32(4, true) !== GCODE_LAYOUT.version ||
    data.getUint32(20, true) !== buffer.byteLength ||
    metadata < 2 ||
    metadata > GCODE_LAYOUT.maxMetadataBytes ||
    records !== model.columns.count ||
    records > GCODE_LAYOUT.maxWindowRecords ||
    points !== model.pathPoints.count ||
    points > GCODE_LAYOUT.maxPathPoints
  )
    return false;
  let offset = Math.ceil((24 + metadata) / 4) * 4;
  for (const field of GCODE_FIELDS) {
    const group = model[field.group] as unknown as Record<string, ArrayBufferView & { length: number }>;
    const values = group[field.name],
      count = field.group === 'columns' ? records : points;
    if (
      !(values instanceof field.ArrayType) ||
      values.buffer !== buffer ||
      values.length !== count ||
      values.byteOffset !== offset
    )
      return false;
    offset = Math.ceil((offset + count * field.bytes) / 4) * 4;
    if (offset > buffer.byteLength) return false;
  }
  return offset === buffer.byteLength;
}
