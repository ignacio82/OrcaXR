/**
 * The external slicer's policy over the hosts' shared contract: an endpoint
 * made canonical, the engine attestation planned and read, a job's requests
 * planned, and each reply of a submission, a status poll, a cancellation and
 * an artifact download read. Every answer comes from the production modules
 * (`ExternalEngineAttestation.ts`, `ExternalSlicerJobs.ts`), driven over
 * scripted fetchers where they carry an exchange out themselves; the Rust
 * core answers the same requests (`orcaxr_printer::slicer`).
 */
import type {
  ProjectExternalSlicerArtifactFactsWire,
  ProjectExternalSlicerArtifactReadWire,
  ProjectExternalSlicerArtifactWire,
  ProjectExternalSlicerAttestationPlanWire,
  ProjectExternalSlicerAttestationWire,
  ProjectExternalSlicerCancelReadWire,
  ProjectExternalSlicerCancelStepWire,
  ProjectExternalSlicerEndpointRequestWire,
  ProjectExternalSlicerEndpointWire,
  ProjectExternalSlicerFailureWire,
  ProjectExternalSlicerJobRequestWire,
  ProjectExternalSlicerPlanWire,
  ProjectExternalSlicerPollReadWire,
  ProjectExternalSlicerPollStepWire,
  ProjectExternalSlicerReplyWire,
  ProjectExternalSlicerSendWire,
  ProjectExternalSlicerSubmissionWire,
  ProjectExternalSlicerSubmitReadWire,
} from '../../../contracts/generated/project-intents';
import { fromUnits, units } from '../printer/PrinterWire';
import { attestExternalEndpoint, canonicalExternalEndpoint } from './ExternalEngineAttestation';
import {
  CANCELLATION_TIMED_OUT,
  RELEASE_TIMEOUT_MS,
  SUBMISSION_PATH,
  confirmExternalCancellation,
  jobUrl,
  pollExternalJob,
  readCancelReply,
  readExternalResult,
  readJobPoll,
  readSubmission,
  type ExternalJobContext,
  type ExternalReply,
} from './ExternalSlicerJobs';
import { SlicerClientCancellationError } from './SlicerClientCancellationError';
import { sha256Bytes } from './Utf8Sha256';

const absent = { absent: {} } as const;
const optional = (value: string | null) => (value === null ? absent : { value: units(value) });

/** A failure as the browser raises it: its sentence and what it means for the job. */
export function failureWire(error: unknown): ProjectExternalSlicerFailureWire {
  const message = error instanceof Error ? error.message : String(error);
  let kind: ProjectExternalSlicerFailureWire['kind'] = 'failed';
  if (error instanceof SlicerClientCancellationError) {
    kind = error.cancellationConfirmed
      ? 'cancelled'
      : error.terminalStatus === 'done'
        ? 'alreadyDone'
        : error.terminalStatus === 'error'
          ? 'alreadyFailed'
          : error.terminalStatus === 'released'
            ? 'alreadyReleased'
            : 'unconfirmed';
  }
  return { kind, message: units(message) };
}

function send(method: string, url: string, operation: string, timeoutMs?: number): ProjectExternalSlicerSendWire {
  return {
    method: units(method),
    url: units(url),
    operation: units(operation),
    timeoutMs: timeoutMs === undefined ? absent : { value: timeoutMs },
  };
}

const replyFromWire = (reply: ProjectExternalSlicerReplyWire): ExternalReply =>
  'failed' in reply
    ? { failed: fromUnits(reply.failed) }
    : { status: reply.response.status, body: fromUnits(reply.response.body) };

/** The endpoint a captured address names, or why none can be made from it. */
export function answerEndpoint(request: ProjectExternalSlicerEndpointRequestWire): ProjectExternalSlicerEndpointWire {
  try {
    return { endpoint: units(canonicalExternalEndpoint(fromUnits(request.input))) };
  } catch (error) {
    return { refused: units((error as Error).message) };
  }
}

/** What an attestation sends, or — when no request can be made — how it reads. */
export async function answerAttestationPlan(
  request: ProjectExternalSlicerEndpointRequestWire,
): Promise<ProjectExternalSlicerAttestationPlanWire> {
  let sent: string | undefined;
  const result = await attestExternalEndpoint(fromUnits(request.input), async (url) => {
    sent = url;
    throw new Error('sent');
  });
  if (sent !== undefined) return { send: send('GET', sent, 'engine_attestation') };
  if (result.attested) throw new Error('An attestation without a reply');
  return { unattested: units(result.reason) };
}

/** An attestation reply read as the production fetcher delivers it (`ok` for 2xx, `json()` its body). */
export async function answerAttestation(
  reply: ProjectExternalSlicerReplyWire,
): Promise<ProjectExternalSlicerAttestationWire> {
  const result = await attestExternalEndpoint('http://127.0.0.1:3000', async () => {
    if ('failed' in reply) throw new Error(fromUnits(reply.failed));
    const { status, body } = reply.response;
    return { ok: status >= 200 && status <= 299, status, json: async () => JSON.parse(fromUnits(body)) };
  });
  return result.attested
    ? { attested: { commit: units(result.commit), artifactHash: units(result.artifactHash), engine: result.engine } }
    : { unattested: units(result.reason) };
}

/** What submitting a project to a captured endpoint sends. */
export function answerSubmitPlan(request: ProjectExternalSlicerEndpointRequestWire): ProjectExternalSlicerPlanWire {
  try {
    return {
      send: send('POST', `${canonicalExternalEndpoint(fromUnits(request.input))}${SUBMISSION_PATH}`, 'slice_submit'),
    };
  } catch (error) {
    return { refused: failureWire(error) };
  }
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/**
 * The request one step of a job sends, as the production loops send it, or
 * how that loop ends when it can send nothing (a job ID no URL can carry; a
 * release is then skipped, which its refusal stands for).
 */
export async function answerJobPlan(
  request: ProjectExternalSlicerJobRequestWire,
): Promise<ProjectExternalSlicerPlanWire> {
  const sent: { method: string; url: string }[] = [];
  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    sent.push({ method: init.method ?? 'GET', url: String(input) });
    if (sent.length === 1 && request.step !== 'artifact') return json({ status: 'cancelled' });
    if (sent.length === 1) return json({ status: 'done' });
    throw new Error('sent');
  };
  const context: ExternalJobContext = {
    endpoint: fromUnits(request.endpoint),
    jobId: fromUnits(request.jobId),
    headers: {},
    pollIntervalMs: 0,
    cancellationTimeoutMs: 10_000,
    fetcher,
  };
  let ended: unknown;
  if (request.step === 'status' || request.step === 'artifact') {
    await pollExternalJob(context).catch((error: unknown) => (ended = error));
    const call = sent[request.step === 'status' ? 0 : 1];
    if (!call) return { refused: failureWire(ended) };
    return { send: send(call.method, call.url, request.step === 'status' ? 'slice_status' : 'slice_artifact') };
  }
  if (request.step === 'cancel') {
    await confirmExternalCancellation(context).catch((error: unknown) => (ended = error));
    if (!sent.length) return { refused: failureWire(ended) };
    return { send: send(sent[0].method, sent[0].url, 'slice_cancel') };
  }
  // A release follows a validated artifact that named its digest.
  const body = new TextEncoder().encode('G28\n');
  await readExternalResult(
    new Response(body, { headers: { 'x-orcaxr-gcode-sha256': sha256Bytes(body).slice(7) } }),
    context,
  );
  if (!sent.length) {
    try {
      jobUrl(context);
    } catch (error) {
      return { refused: failureWire(error) };
    }
  }
  return { send: send(sent[0].method, sent[0].url, 'slice_release', RELEASE_TIMEOUT_MS) };
}

/** A submission reply read as the canonical route reads it. */
export function answerSubmission(request: ProjectExternalSlicerSubmitReadWire): ProjectExternalSlicerSubmissionWire {
  const reply = request.reply;
  const step = readSubmission(
    'failed' in reply
      ? { failed: fromUnits(reply.failed) }
      : {
          status: reply.response.status,
          body: fromUnits(reply.response.body),
          jobIdHeader: 'value' in reply.response.jobIdHeader ? fromUnits(reply.response.jobIdHeader.value) : null,
        },
    request.aborted,
  );
  if (step.kind === 'job') return { job: units(step.jobId) };
  if (step.kind === 'cancel') return { cancel: units(step.jobId) };
  if (step.kind === 'artifact') return { artifact: {} };
  return { failed: failureWire(step.error) };
}

/** One status poll's reply, after [failures] consecutive failures. */
export function answerPoll(request: ProjectExternalSlicerPollReadWire): ProjectExternalSlicerPollStepWire {
  const step = readJobPoll(request.failures, replyFromWire(request.reply));
  if (step.kind === 'download') return { download: {} };
  if (step.kind === 'failed') return { failed: failureWire(step.error) };
  return {
    wait: {
      failures: step.failures,
      progress: step.progress
        ? { value: { percent: step.progress.percent, message: units(step.progress.message) } }
        : absent,
    },
  };
}

/** One reply while a cancellation is being confirmed, or its deadline passing. */
export function answerCancel(request: ProjectExternalSlicerCancelReadWire): ProjectExternalSlicerCancelStepWire {
  if ('timedOut' in request)
    return { failed: failureWire(new SlicerClientCancellationError(CANCELLATION_TIMED_OUT, false)) };
  const step = readCancelReply(replyFromWire(request.reply));
  if (step.kind === 'confirmed') return { confirmed: {} };
  if (step.kind === 'poll') return { poll: {} };
  return { failed: failureWire(step.error) };
}

/**
 * What a host computes of a downloaded artifact as it streams: its length,
 * its SHA-256 (lowercase hex), whether it is valid UTF-8, and whether its text
 * (UTF-8, a leading byte-order mark dropped) is only ECMAScript white space
 * and line terminators, as `String.prototype.trim` reads them.
 */
export function artifactFacts(
  bytes: Uint8Array,
  reply: { status: number; errorBody?: string; headers: Readonly<Record<string, string>> },
): ProjectExternalSlicerArtifactFactsWire {
  let text: string | undefined;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    text = undefined;
  }
  // As the reply's own `Headers` read them: any case, surrounding white space dropped.
  const headers = new Headers(reply.headers);
  const header = (name: string) => headers.get(name);
  return {
    status: reply.status,
    errorBody: units(reply.errorBody ?? ''),
    jobIdHeader: optional(header('x-orcaxr-job-id')),
    sha256Header: optional(header('x-orcaxr-gcode-sha256')),
    bytesHeader: optional(header('x-orcaxr-gcode-bytes')),
    length: bytes.length,
    sha256: units(sha256Bytes(bytes).slice(7)),
    utf8: text !== undefined,
    blank: text !== undefined && !text.trim(),
  };
}

/**
 * An artifact download read by the production `readExternalResult` over the
 * reply the facts were computed from: accepted (and the job it then releases,
 * if any), or the failure it reads as.
 */
export async function answerArtifact(
  request: ProjectExternalSlicerArtifactReadWire,
  bytes: Uint8Array,
  headers: Readonly<Record<string, string>>,
  errorBody = '',
): Promise<ProjectExternalSlicerArtifactWire> {
  const facts = request.response;
  const released: string[] = [];
  const response = new Response(facts.status >= 200 && facts.status <= 299 ? new Uint8Array(bytes) : errorBody, {
    status: facts.status,
    headers,
  });
  try {
    await readExternalResult(response, {
      endpoint: 'http://127.0.0.1:3000',
      ...('value' in request.expectedJobId ? { jobId: fromUnits(request.expectedJobId.value) } : {}),
      headers: {},
      pollIntervalMs: 0,
      cancellationTimeoutMs: 1000,
      fetcher: async (input) => {
        released.push(decodeURIComponent(String(input).split('/jobs/')[1]));
        return json({ status: 'done', released: true });
      },
    });
  } catch (error) {
    return { failed: failureWire(error) };
  }
  return { accepted: { release: released.length ? { value: units(released[0]) } : absent } };
}
