/**
 * The volume-role editor's model, without a DOM.
 *
 * The semantic object editor shows the selected part's role and offers one
 * choice per role in upstream Orca's order: the current role marked, every
 * other enabled only when the conversion command would accept it, and a
 * blocked choice explained in the command's words. Each conversion is named
 * while it runs and once it is done. Native hosts run the same rules in the
 * shared core (`orcaxr_project::volume_role_editor`), replaying this file's
 * answers.
 */
import type { ObjectId, VolumeId } from '../domain/ids';
import type { ProjectState, VolumeRole } from '../domain/model';
import { findVolume } from '../domain/selectors';
import {
  inspectVolumeRoleConversion,
  ORCA_VOLUME_ROLE_ORDER,
  type VolumeRoleConversionDecision,
} from './semanticVolumeCommands';

/** One role a part can be converted to, as the editor offers it. */
export interface VolumeRoleChoice {
  readonly role: VolumeRole;
  readonly label: string;
  /** The part has this role now. */
  readonly current: boolean;
  /** `inspectVolumeRoleConversion` for this role. */
  readonly decision: VolumeRoleConversionDecision;
  /** Why the choice is not offered, in the editor's words; absent when it is. */
  readonly blockedReason?: string;
}

/** One part's role and every role it could become, as the editor shows them. */
export interface VolumeRoleEditorProjection {
  readonly objectId: ObjectId;
  readonly objectName: string;
  readonly volumeId: VolumeId;
  readonly volumeName: string;
  readonly role: VolumeRole;
  /** The section's summary line: `name — Role`. */
  readonly summary: string;
  /** One per role, in `ORCA_VOLUME_ROLE_ORDER`. */
  readonly choices: readonly VolumeRoleChoice[];
}

/**
 * [volumeId]'s role and what converting it to each role would do; undefined
 * for a volume the project lacks.
 */
export function volumeRoleEditorProjection(
  state: ProjectState,
  volumeId: VolumeId,
): VolumeRoleEditorProjection | undefined {
  const found = findVolume(state, volumeId);
  if (!found) return undefined;
  const { object, volume } = found;
  return {
    objectId: object.id,
    objectName: object.name,
    volumeId: volume.id,
    volumeName: volume.name,
    role: volume.role,
    summary: volumeRoleSummary(volume.name, volume.role),
    choices: ORCA_VOLUME_ROLE_ORDER.map((role) => {
      const decision = inspectVolumeRoleConversion(state, volume.id, role);
      const current = volume.role === role;
      const blockedReason = volumeRoleBlockReason(decision, current, 1);
      return { role, label: volumeRoleLabel(role), current, decision, ...(blockedReason ? { blockedReason } : {}) };
    }),
  };
}

/** A role as the editor names it. */
export function volumeRoleLabel(role: VolumeRole): string {
  switch (role) {
    case 'model':
      return 'Part';
    case 'negative-volume':
      return 'Negative volume';
    case 'parameter-modifier':
      return 'Parameter modifier';
    case 'support-blocker':
      return 'Support blocker';
    case 'support-enforcer':
      return 'Support enforcer';
  }
}

/** The editor's summary of a part: its name and role. */
export function volumeRoleSummary(name: string, role: VolumeRole): string {
  return `${name} — ${volumeRoleLabel(role)}`;
}

/**
 * Why a role choice is not offered: no single decision for it, the part's
 * current role (or a conversion that changes nothing), or the command's
 * refusal; undefined for a conversion the command accepts.
 */
export function volumeRoleBlockReason(
  decision: VolumeRoleConversionDecision | undefined,
  isCurrent: boolean,
  matchingDecisionCount: number,
): string | undefined {
  if (matchingDecisionCount !== 1 || !decision) return 'A unique canonical conversion decision was not provided.';
  if (isCurrent || (decision.allowed && decision.noop)) return 'This is the current role; no conversion is needed.';
  return decision.allowed ? undefined : decision.reason;
}

/** What converting the part named [volumeName] to [role] says while it runs and once the project took it. */
export function volumeRoleOperationMessages(
  volumeName: string,
  role: VolumeRole,
): { readonly pending: string; readonly success: string } {
  const label = volumeRoleLabel(role);
  return { pending: `Converting ${volumeName} to ${label}…`, success: `Converted ${volumeName} to ${label}.` };
}
