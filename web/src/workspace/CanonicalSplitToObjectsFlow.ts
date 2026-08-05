import type {
  CanonicalSplitToObjectsConfirmation,
  CanonicalSplitToObjectsGuard,
  CanonicalSplitToObjectsResult,
} from './CanonicalWorkspaceController';

export interface CanonicalSplitToObjectsWorkspacePort {
  getSplitToObjectsConfirmation(): CanonicalSplitToObjectsConfirmation;
  splitSelectedToObjects(guard: CanonicalSplitToObjectsGuard): CanonicalSplitToObjectsResult;
}

export type CanonicalSplitToObjectsConfirmationPort = (
  confirmation: CanonicalSplitToObjectsConfirmation,
) => boolean | Promise<boolean>;

/**
 * Presentation-neutral workspace flow. Capture and commit errors become
 * actionable status without leaking a partially prepared topology result.
 */
export async function runCanonicalSplitToObjectsFlow(
  project: CanonicalSplitToObjectsWorkspacePort,
  requestConfirmation: CanonicalSplitToObjectsConfirmationPort | null,
  reportStatus: (message: string) => void,
): Promise<CanonicalSplitToObjectsResult | undefined> {
  let confirmation: CanonicalSplitToObjectsConfirmation;
  try {
    confirmation = project.getSplitToObjectsConfirmation();
  } catch (error) {
    reportStatus(`Split to Objects unavailable: ${errorMessage(error)}`);
    return undefined;
  }
  if (!requestConfirmation) {
    reportStatus('Split to Objects needs an explicit confirmation surface; the project was not changed.');
    return undefined;
  }

  let confirmed: boolean;
  try {
    confirmed = await requestConfirmation(confirmation);
  } catch (error) {
    reportStatus(`Split to Objects confirmation failed: ${errorMessage(error)}. The project was not changed.`);
    return undefined;
  }
  if (!confirmed) {
    reportStatus('Split to Objects cancelled; the project was not changed.');
    return undefined;
  }

  try {
    const result = project.splitSelectedToObjects(confirmation.guard);
    const instanceCount = confirmation.affectedInstanceIds.length;
    reportStatus(
      `Split ${confirmation.objectName} into ${result.objectIds.length} objects across all ${instanceCount} instance${instanceCount === 1 ? '' : 's'} in one undoable edit.`,
    );
    return result;
  } catch (error) {
    reportStatus(`Split to Objects failed: ${errorMessage(error)}. The project was not changed.`);
    return undefined;
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\r\n\t]+/g, ' ').trim() || 'Unknown error';
}
