export class PaintHistory {
    public static readonly MAX_DEPTH = 20;

    private byModel = new Map<string, ModelState>();

    public beginStroke(modelId: string, currentState: Snapshot): void {
        let s = this.byModel.get(modelId);
        if (!s) {
            s = new ModelState();
            this.byModel.set(modelId, s);
        }
        if (s.pending !== null) return;
        s.pending = currentState;
        s.redoStack = [];
    }

    public endStroke(modelId: string, endState: Snapshot): void {
        const s = this.byModel.get(modelId);
        if (!s) return;
        const before = s.pending;
        if (!before) return;
        s.pending = null;
        if (Snapshot.equals(before, endState)) return;
        s.undoStack.push(new Stroke(before, endState));
        while (s.undoStack.length > PaintHistory.MAX_DEPTH) {
            s.undoStack.shift();
        }
    }

    public cancelStroke(modelId: string): void {
        const s = this.byModel.get(modelId);
        if (s) {
            s.pending = null;
        }
    }

    public canUndo(modelId: string): boolean {
        const s = this.byModel.get(modelId);
        return s ? s.undoStack.length > 0 : false;
    }

    public canRedo(modelId: string): boolean {
        const s = this.byModel.get(modelId);
        return s ? s.redoStack.length > 0 : false;
    }

    public undo(modelId: string): Snapshot | null {
        const s = this.byModel.get(modelId);
        if (!s) return null;
        if (s.undoStack.length === 0) return null;
        if (s.pending !== null) {
            const pending = s.pending;
            s.pending = null;
            return pending;
        }
        const stroke = s.undoStack.pop()!;
        s.redoStack.push(stroke);
        return stroke.before;
    }

    public redo(modelId: string): Snapshot | null {
        const s = this.byModel.get(modelId);
        if (!s) return null;
        if (s.redoStack.length === 0) return null;
        const stroke = s.redoStack.pop()!;
        s.undoStack.push(stroke);
        return stroke.after;
    }

    public clear(modelId: string): void {
        this.byModel.delete(modelId);
    }

    public undoDepth(modelId: string): number {
        return this.byModel.get(modelId)?.undoStack.length || 0;
    }

    public redoDepth(modelId: string): number {
        return this.byModel.get(modelId)?.redoStack.length || 0;
    }
}

export class Stroke {
    constructor(
        public readonly before: Snapshot,
        public readonly after: Snapshot
    ) {}
}

export class Snapshot {
    constructor(
        public readonly paintFilamentIndex: Int8Array | null = null,
        public readonly supportFlags: Int8Array | null = null,
        public readonly seamFlags: Int8Array | null = null,
        public readonly fuzzySkinFlags: Int8Array | null = null
    ) {}

    public static equals(a: Snapshot | null, b: Snapshot | null): boolean {
        if (a === b) return true;
        if (a === null || b === null) return false;
        return Snapshot.arrEq(a.paintFilamentIndex, b.paintFilamentIndex) &&
               Snapshot.arrEq(a.supportFlags, b.supportFlags) &&
               Snapshot.arrEq(a.seamFlags, b.seamFlags) &&
               Snapshot.arrEq(a.fuzzySkinFlags, b.fuzzySkinFlags);
    }

    private static arrEq(a: Int8Array | null, b: Int8Array | null): boolean {
        if (a === b) return true;
        if (a === null || b === null) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }
}

class ModelState {
    public undoStack: Stroke[] = [];
    public redoStack: Stroke[] = [];
    public pending: Snapshot | null = null;
}
