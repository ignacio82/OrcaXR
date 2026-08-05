import type { AssetId } from '../domain/ids';
import { Bbs3mfProjectSerializer } from '../serialization/Bbs3mfProjectSerializer';
import {
  ImportCancelledError,
  type ImportDiagnostic,
  type ParsedProjectImport,
  type ProjectImportParseRequest,
  type ProjectImportParserPort,
} from './types';
import type { CancellationToken } from '../ports';

const THREE_MF_ZIP_SIGNATURES = new Set(['504b0304', '504b0506', '504b0708']);

/**
 * Pure replace-mode parser used inside the browser import worker. Merge-mode
 * entity policy belongs to the transactional coordinator and is deliberately
 * not guessed here.
 */
export class BbsProjectImportParser implements ProjectImportParserPort {
  constructor(private readonly serializer = new Bbs3mfProjectSerializer()) {}

  async parse(request: ProjectImportParseRequest): Promise<ParsedProjectImport> {
    throwIfCancelled(request);
    if (request.mode !== 'replace') {
      throw new Error('BBS project import currently supports replace mode only');
    }
    return this.parseArchive(request.bytes, request.cancellation);
  }

  /** Worker-friendly path that deliberately carries no base project bundle. */
  async parseArchive(bytes: Uint8Array, cancellation?: CancellationToken): Promise<ParsedProjectImport> {
    throwIfCancelled({ cancellation });
    if (!hasThreeMfZipSignature(bytes)) {
      throw new Error('BBS project import requires a ZIP-signature 3MF archive');
    }

    const parsed = await this.serializer.deserialize(bytes.slice(), cancellation);
    throwIfCancelled({ cancellation });
    return {
      state: parsed.state,
      assets: parsed.assets,
      importedAssetIds: parsed.assets.map((asset) => asset.descriptor.id as AssetId),
      diagnostics: warningsToDiagnostics(parsed.warnings),
    };
  }
}

function warningsToDiagnostics(warnings: readonly string[]): ImportDiagnostic[] {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))].map((message, index) => ({
    id: `bbs-import-warning-${index + 1}`,
    severity: 'warning',
    code: 'bbs-import-warning',
    path: '$',
    message,
  }));
}

function hasThreeMfZipSignature(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  return THREE_MF_ZIP_SIGNATURES.has(
    Array.from(bytes.subarray(0, 4), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
}

function throwIfCancelled(request: { readonly cancellation?: CancellationToken }): void {
  if (request.cancellation?.aborted) throw new ImportCancelledError(request.cancellation.reason);
}
