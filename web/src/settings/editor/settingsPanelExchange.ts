/**
 * The hosts' contract for the generated settings panel (`settingsPanel.ts`):
 * canonical JSON requests and replies over one panel model, every answer from
 * the production model. The shared Rust core answers the same requests over a
 * host editor (`settings::editor::panel_exchange`).
 *
 * - view `{"mode","search"}` → `{"sections","shown","summary","unavailable"}`;
 * - row `{"fieldId"}` → `{"row"}`, or `{"refused"}` with the editor's message;
 * - edit `{"fieldId","op":"set","raw"}`, `{"fieldId","op":"inherit"}` or
 *   `{"fieldId","op":"default"}` → `{"outcome":"applied"}`,
 *   `{"message","outcome":"unserializable"}` (a default the codec cannot write)
 *   or `{"message","outcome":"refused"}` (what the model throws);
 * - state → `{"changed","drafts","invalid"}`;
 * - apply → `{"changes","outcome":"committed"}` with the commit,
 *   `{"outcome":"unchanged"}` (the drafts dropped), `{"message","outcome":"invalid"}`
 *   (validation) or `{"message","outcome":"failed"}`;
 * - target texts `{"label","overrideCount","path","scope"}` →
 *   `{"heading","summary","text"}`.
 *
 * A malformed request is refused as `invalid_request`.
 */
import { canonicalStringify } from '../../project/domain/canonical';
import type { SettingScope } from '../generated/settingScopes';
import {
  scopedSettingsHeading,
  scopedSettingsOptionText,
  scopedSettingsSummary,
  type SettingsPanelModel,
} from './settingsPanel';
import { SettingsDraftCommitError, type SettingsDraftCommit, type SettingsEditorMode } from './types';

export const INVALID_REQUEST = 'invalid_request';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

function invalid(): never {
  throw new Error(INVALID_REQUEST);
}
function read(request: string, keys: readonly string[]): JsonObject {
  let value: Json;
  try {
    value = JSON.parse(request) as Json;
  } catch {
    invalid();
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid();
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(value, key)) invalid();
  return value;
}
function text(value: Json | undefined): string {
  if (typeof value !== 'string') invalid();
  return value;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
const SCOPES: readonly SettingScope[] = ['project', 'plate', 'object', 'part', 'layerRange'];
const MODES: readonly SettingsEditorMode[] = ['simple', 'advanced', 'develop'];

export function settingsPanelViewExchange(model: SettingsPanelModel, request: string): string {
  const fields = read(request, ['mode', 'search']);
  const mode = text(fields.mode) as SettingsEditorMode;
  if (!MODES.includes(mode)) invalid();
  return canonicalStringify(model.view(mode, text(fields.search)));
}

export function settingsPanelRowExchange(model: SettingsPanelModel, request: string): string {
  const fieldId = text(read(request, ['fieldId']).fieldId);
  try {
    return canonicalStringify({ row: model.row(fieldId) });
  } catch (error) {
    return canonicalStringify({ refused: message(error) });
  }
}

export function settingsPanelEditExchange(model: SettingsPanelModel, request: string): string {
  let op: string;
  try {
    op = text((JSON.parse(request) as JsonObject).op);
  } catch {
    invalid();
  }
  const fields = read(request, op === 'set' ? ['fieldId', 'op', 'raw'] : ['fieldId', 'op']);
  const fieldId = text(fields.fieldId);
  try {
    if (op === 'set') model.set(fieldId, text(fields.raw));
    else if (op === 'inherit') model.inherit(fieldId);
    else if (op === 'default') {
      const reset = model.useDefault(fieldId);
      if (!reset.ok) return canonicalStringify({ message: reset.error.message, outcome: 'unserializable' });
    } else invalid();
  } catch (error) {
    if (error instanceof Error && error.message === INVALID_REQUEST) throw error;
    return canonicalStringify({ message: message(error), outcome: 'refused' });
  }
  return canonicalStringify({ outcome: 'applied' });
}

export function settingsPanelStateExchange(model: SettingsPanelModel): string {
  return canonicalStringify({ ...model.state(), drafts: model.draftFieldIds.length });
}

/** Apply's reply, and the commit when it changes something (the drafts dropped when it does not). */
export function settingsPanelApplyExchange(model: SettingsPanelModel): {
  readonly reply: string;
  readonly commit?: SettingsDraftCommit;
} {
  let commit: SettingsDraftCommit;
  try {
    commit = model.prepare();
  } catch (error) {
    if (error instanceof SettingsDraftCommitError) {
      return { reply: canonicalStringify({ message: error.message, outcome: 'invalid' }) };
    }
    const text = error instanceof Error && error.message ? error.message : 'Unknown settings error';
    return { reply: canonicalStringify({ message: text, outcome: 'failed' }) };
  }
  if (commit.changes.length === 0) {
    model.discard();
    return { reply: canonicalStringify({ outcome: 'unchanged' }) };
  }
  return { reply: canonicalStringify({ changes: commit.changes.length, outcome: 'committed' }), commit };
}

export function settingsTargetTextExchange(request: string): string {
  const fields = read(request, ['label', 'overrideCount', 'path', 'scope']);
  const scope = text(fields.scope) as SettingScope;
  if (!SCOPES.includes(scope)) invalid();
  const count = fields.overrideCount;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) invalid();
  return canonicalStringify({
    heading: scopedSettingsHeading(scope, text(fields.label)),
    summary: scopedSettingsSummary(scope),
    text: scopedSettingsOptionText(scope, text(fields.path), count),
  });
}
