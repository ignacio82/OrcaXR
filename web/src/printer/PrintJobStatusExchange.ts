/**
 * The print job snapshot over the hosts' shared contract (`PrintJobSnapshot`):
 * absent fields stay absent, text keeps every UTF-16 unit. The Rust core
 * projects the same snapshot from the same replies and events
 * (`orcaxr_printer::status`).
 */
import type {
  ProjectOptionalFiniteWire,
  ProjectOptionalPrintJobTemperatureWire,
  ProjectOptionalTextWire,
  ProjectPrintJobSnapshotWire,
} from '../../../contracts/generated/project-intents';
import type { PrintJobSnapshot, PrintJobTemperature } from './PrintJobStatus';

const absent = { absent: {} } as const;
const units = (text: string): number[] => Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));
const text = (value: string | undefined): ProjectOptionalTextWire =>
  value === undefined ? absent : { value: units(value) };
const finite = (value: number | undefined): ProjectOptionalFiniteWire => (value === undefined ? absent : { value });
const temperature = (value: PrintJobTemperature | undefined): ProjectOptionalPrintJobTemperatureWire =>
  value === undefined ? absent : { value: { actualC: value.actualC, targetC: value.targetC } };

export function printJobSnapshotWire(snapshot: PrintJobSnapshot): ProjectPrintJobSnapshotWire {
  return {
    state: snapshot.state,
    klippyState: text(snapshot.klippyState),
    filename: text(snapshot.filename),
    virtualSdActive: snapshot.virtualSdActive === undefined ? absent : { value: snapshot.virtualSdActive },
    message: text(snapshot.message),
    progress: finite(snapshot.progress),
    currentLayer: finite(snapshot.currentLayer),
    totalLayers: finite(snapshot.totalLayers),
    printDurationS: finite(snapshot.printDurationS),
    totalDurationS: finite(snapshot.totalDurationS),
    filamentUsedMm: finite(snapshot.filamentUsedMm),
    estimatedRemainingS: finite(snapshot.estimatedRemainingS),
    extruder: temperature(snapshot.extruder),
    bed: temperature(snapshot.bed),
    updatedAtMs: snapshot.updatedAtMs,
  };
}
