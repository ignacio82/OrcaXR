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
 * Settings this build round-trips faithfully but does not act on.
 *
 * Preserving them is right — dropping a setting silently loses someone's work,
 * and a project exported from here should still carry what it arrived with.
 * But *arriving* with one and saying nothing is its own silent divergence: the
 * operator opens a project whose text is projected onto a curved surface, gets
 * a flat extrusion, and has nothing to tell them the geometry is not what the
 * file describes.
 *
 * So they are reported on import. Each entry is a setting the serializer
 * preserves and no code applies; removing one from this list is part of
 * implementing it, not a separate tidy-up.
 */
const UNHONOURED_SETTINGS = Object.freeze([
  {
    field: 'use_surface',
    message:
      'This project projects text or an SVG onto the model surface. OrcaXR preserves that setting but extrudes flat, so the imported geometry differs from what the file describes.',
  },
  {
    field: 'per_glyph',
    message:
      'This project embosses each glyph as its own volume. OrcaXR preserves that setting but cuts one volume, so the imported geometry differs from what the file describes.',
  },
]);

/** Which unhonoured settings this project actually carries. */
function unhonouredSettings(state: unknown): ImportDiagnostic[] {
  // Read from the serialized state rather than from the archive text, so this
  // reports what was actually parsed rather than what happened to appear in a
  // file — a comment mentioning `use_surface` would otherwise raise a warning
  // about geometry nobody asked for.
  const serialized = JSON.stringify(state ?? {});
  const notices: ImportDiagnostic[] = [];
  for (const setting of UNHONOURED_SETTINGS) {
    const camel = setting.field.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (new RegExp(`"${camel}":true`).test(serialized)) {
      notices.push({
        id: `unhonoured-${setting.field}`,
        code: `unhonoured-${setting.field}`,
        path: `$.${setting.field}`,
        severity: 'warning',
        message: setting.message,
      });
    }
  }
  return notices;
}

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
    const unhonoured = unhonouredSettings(parsed.state);
    return {
      state: parsed.state,
      assets: parsed.assets,
      importedAssetIds: parsed.assets.map((asset) => asset.descriptor.id as AssetId),
      diagnostics: [...warningsToDiagnostics(parsed.warnings), ...unhonoured],
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
