export interface IndexEntry {
    byMakerworldId: Record<string, string>;
    bySha256: Record<string, string>;
    byFilenameAlias: Record<string, string>;
}

export enum MatchKey {
    MakerworldId = "MakerworldId",
    Sha256 = "Sha256",
    FilenameAlias = "FilenameAlias"
}

export interface Resolution {
    recipeName: string;
    matchedBy: MatchKey;
    key: string;
}

export class PaintTemplateResolver {
    public static resolveAgainst(index: IndexEntry, filename: string, sha256?: string): Resolution | null {
        // 1. MakerWorld design id
        const mwId = this.makerworldIdFor(filename);
        if (mwId && index.byMakerworldId[mwId]) {
            return {
                recipeName: index.byMakerworldId[mwId],
                matchedBy: MatchKey.MakerworldId,
                key: mwId
            };
        }
        
        // 2. SHA-256
        if (sha256 && index.bySha256[sha256]) {
            return {
                recipeName: index.bySha256[sha256],
                matchedBy: MatchKey.Sha256,
                key: sha256
            };
        }
        
        // 3. Filename alias
        const key = this.filenameAlias(filename);
        if (key && index.byFilenameAlias[key]) {
            return {
                recipeName: index.byFilenameAlias[key],
                matchedBy: MatchKey.FilenameAlias,
                key: key
            };
        }
        
        return null;
    }

    public static filenameAlias(filename: string): string | null {
        const base = filename.substring(0, filename.lastIndexOf('.')) || filename;
        if (!base) return null;
        const lower = base.toLowerCase();
        const noMwTail = lower.split('+')[0];
        const collapsed = noMwTail.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
        if (!collapsed) return null;
        return collapsed;
    }

    public static makerworldIdFor(filename: string): string | null {
        const base = filename.substring(0, filename.lastIndexOf('.')) || filename;
        const parts = base.split('+');
        if (parts.length > 1) {
            const candidate = parts[parts.length - 1];
            if (this.looksLikeMakerworldId(candidate)) return candidate;
        }
        return null;
    }

    private static looksLikeMakerworldId(s: string): boolean {
        if (s.length < 8 || s.length > 64) return false;
        return /^[A-Za-z0-9\-_]+$/.test(s);
    }
}
