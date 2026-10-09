/**
 * Printer cameras over the hosts' shared contract (`PrinterCamera.ts`): the
 * listing a printer's cameras read as (or the result an exchange that ended
 * without a reply reads as), a frame's route and what its failed fetch reads
 * as, the routes worth trying, the service's description, the poll interval
 * and a fresh frame URL. Every answer comes from the production functions;
 * the Rust core answers the same requests (`orcaxr_printer::camera`).
 */
import type {
  ProjectCameraDescribeRequestWire,
  ProjectCameraFailureWire,
  ProjectCameraFrameRequestWire,
  ProjectCameraListFinishWire,
  ProjectCameraListRequestWire,
  ProjectCameraListResultWire,
  ProjectCameraMechanismsRequestWire,
  ProjectCameraMechanismsWire,
  ProjectCameraSnapshotFinishWire,
  ProjectCameraSnapshotPlanWire,
  ProjectCameraSnapshotRequestWire,
  ProjectOptionalPrinterReplyTextWire,
  ProjectPrinterCameraWire,
  ProjectPrinterSendWire,
  ProjectPrinterTextWire,
} from '../../../contracts/generated/project-intents';
import { MoonrakerTransportError, type MoonrakerErrorCode } from './MoonrakerTypes';
import {
  PrinterCameraError,
  cameraDirectFrameUrl,
  cameraMechanisms,
  cameraPollIntervalMs,
  cameraSnapshotFailure,
  describeCameraService,
  listPrinterCameras,
  planCameraSnapshot,
  type CameraService,
  type CameraSnapshotOutcome,
  type PrinterCamera,
  type PrinterCameraTransport,
} from './PrinterCamera';
import { fromUnits, units } from './PrinterWire';

const absent = { absent: {} } as const;
const camel = (code: string): string => code.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const snake = (code: string): string => code.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const optional = (value: string | undefined) => (value === undefined ? absent : { value: units(value) });
const read = (value: { readonly value: readonly number[] } | { readonly absent: object }) =>
  'value' in value ? fromUnits(value.value) : undefined;

/** The service names Moonraker reports, by their contract spelling. */
const SERVICES: readonly CameraService[] = [
  'mjpegstreamer',
  'mjpegstreamer-adaptive',
  'uv4l-mjpeg',
  'hlsstream',
  'ipstream',
  'webrtc-camerastreamer',
  'webrtc-go2rtc',
  'webrtc-mediamtx',
  'unknown',
];

function failureWire(error: PrinterCameraError): ProjectCameraFailureWire {
  return { code: camel(error.code) as ProjectCameraFailureWire['code'], message: units(error.message) };
}

export function cameraWire(camera: PrinterCamera): ProjectPrinterCameraWire {
  return {
    uid: units(camera.uid),
    name: units(camera.name),
    service: camel(camera.service) as ProjectPrinterCameraWire['service'],
    enabled: camera.enabled,
    snapshotPath: optional(camera.snapshotPath),
    snapshotUrl: optional(camera.snapshotUrl),
    streamPath: optional(camera.streamPath),
    targetFps: camera.targetFps,
    rotationDegrees: camera.rotationDegrees,
    flipHorizontal: camera.flipHorizontal,
    flipVertical: camera.flipVertical,
    unsupportedReason: optional(camera.unsupportedReason),
  };
}

function cameraFromWire(camera: ProjectPrinterCameraWire): PrinterCamera {
  const service = SERVICES.find((name) => camel(name) === camera.service) ?? 'unknown';
  const snapshotPath = read(camera.snapshotPath);
  const snapshotUrl = read(camera.snapshotUrl);
  const streamPath = read(camera.streamPath);
  const unsupportedReason = read(camera.unsupportedReason);
  return {
    uid: fromUnits(camera.uid),
    name: fromUnits(camera.name),
    service,
    enabled: camera.enabled,
    ...(snapshotPath === undefined ? {} : { snapshotPath }),
    ...(snapshotUrl === undefined ? {} : { snapshotUrl }),
    ...(streamPath === undefined ? {} : { streamPath }),
    targetFps: camera.targetFps,
    rotationDegrees: camera.rotationDegrees as PrinterCamera['rotationDegrees'],
    flipHorizontal: camera.flipHorizontal,
    flipVertical: camera.flipVertical,
    ...(unsupportedReason === undefined ? {} : { unsupportedReason }),
  };
}

/** The listing request, as the shell sends it. */
export function answerCameraListPlan(): ProjectPrinterSendWire {
  let sent: ProjectPrinterSendWire | undefined;
  void listPrinterCameras({
    request: async (path, options) => {
      sent = { path: units(path), method: units('GET'), operation: units(options?.operation ?? ''), timeoutMs: absent };
      throw new Error('sent');
    },
    download: async () => new Uint8Array(0),
  }).catch(() => undefined);
  if (!sent) throw new Error('The listing sent nothing');
  return sent;
}

async function list(
  request: ProjectCameraListRequestWire,
  transport: PrinterCameraTransport,
  signal?: AbortSignal,
): Promise<ProjectCameraListResultWire> {
  const endpoint = read(request.endpoint);
  try {
    return { cameras: (await listPrinterCameras(transport, signal, endpoint)).map(cameraWire) };
  } catch (error) {
    if (error instanceof PrinterCameraError) return { failed: failureWire(error) };
    throw error;
  }
}

/** The result a listing reads as once its exchange ended without a reply to read. */
export async function answerCameraListFinish(
  request: ProjectCameraListFinishWire,
): Promise<ProjectCameraListResultWire> {
  const { outcome } = request;
  const abort = new AbortController();
  const transport: PrinterCameraTransport = {
    request: async () => {
      if ('done' in outcome) return undefined as never;
      if ('cancelled' in outcome) {
        abort.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      const failure = outcome.failed;
      if (!('value' in failure.code)) throw new Error('request failed');
      throw new MoonrakerTransportError(snake(failure.code.value) as MoonrakerErrorCode, 'camera', {
        ...('value' in failure.httpStatus ? { httpStatus: failure.httpStatus.value } : {}),
        ...('value' in failure.detail ? { detail: fromUnits(failure.detail.value) } : {}),
      });
    },
    download: async () => new Uint8Array(0),
  };
  return list(request.request, transport, abort.signal);
}

/** A `/server/webcams/list` reply (Moonraker's `result`, as JSON) read as the shell reads it. */
export async function answerCameraListRead(
  request: ProjectCameraListRequestWire,
  reply: string,
): Promise<ProjectCameraListResultWire> {
  return list(request, { request: async () => JSON.parse(reply), download: async () => new Uint8Array(0) });
}

function route(mechanism: ProjectCameraSnapshotRequestWire['mechanism']) {
  return 'value' in mechanism ? mechanism.value : undefined;
}

export function answerCameraSnapshotPlan(request: ProjectCameraSnapshotRequestWire): ProjectCameraSnapshotPlanWire {
  try {
    const plan = planCameraSnapshot(cameraFromWire(request.camera), route(request.mechanism));
    return plan.kind === 'direct'
      ? { direct: { url: units(plan.url), timeoutMs: plan.timeoutMs } }
      : { transport: { path: units(plan.path), operation: units(plan.operation) } };
  } catch (error) {
    if (error instanceof PrinterCameraError) return { refused: failureWire(error) };
    throw error;
  }
}

export function answerCameraSnapshotFailure(request: ProjectCameraSnapshotFinishWire): ProjectCameraFailureWire {
  const camera = cameraFromWire(request.request.camera);
  try {
    const plan = planCameraSnapshot(camera, route(request.request.mechanism));
    const outcome = request.outcome;
    const read: CameraSnapshotOutcome =
      'cancelled' in outcome
        ? { kind: 'cancelled' }
        : 'status' in outcome
          ? { kind: 'status', status: outcome.status }
          : 'timeout' in outcome
            ? { kind: 'timeout' }
            : 'unreachable' in outcome
              ? { kind: 'unreachable', detail: fromUnits(outcome.unreachable) }
              : {
                  kind: 'transport',
                  ...('value' in outcome.transport ? { code: snake(outcome.transport.value) } : {}),
                };
    return failureWire(cameraSnapshotFailure(camera, plan, read));
  } catch (error) {
    if (error instanceof PrinterCameraError) return failureWire(error);
    throw error;
  }
}

export function answerCameraMechanisms(request: ProjectCameraMechanismsRequestWire): ProjectCameraMechanismsWire {
  return [...cameraMechanisms(cameraFromWire(request.camera), read(request.pageProtocol))];
}

export function answerCameraDescribe(request: ProjectCameraDescribeRequestWire): ProjectPrinterTextWire {
  return {
    text: units(
      describeCameraService(cameraFromWire(request.camera), route(request.route), read(request.pageProtocol)),
    ),
  };
}

export function answerCameraPollInterval(camera: ProjectPrinterCameraWire): number {
  return cameraPollIntervalMs(cameraFromWire(camera));
}

export function answerCameraFrameUrl(request: ProjectCameraFrameRequestWire): ProjectOptionalPrinterReplyTextWire {
  return optional(cameraDirectFrameUrl(cameraFromWire(request.camera), fromUnits(request.nonce)));
}
