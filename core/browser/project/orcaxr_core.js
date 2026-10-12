/* @ts-self-types="./orcaxr_core.d.ts" */

export class CapturedHistory {
    static __wrap(ptr) {
        const obj = Object.create(CapturedHistory.prototype);
        obj.__wbg_ptr = ptr;
        CapturedHistoryFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CapturedHistoryFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_capturedhistory_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    dirty_categories() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.capturedhistory_dirty_categories(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {boolean} undo
     * @returns {boolean}
     */
    has_label(undo) {
        const ret = wasm.capturedhistory_has_label(this.__wbg_ptr, undo);
        return ret !== 0;
    }
    /**
     * @param {boolean} undo
     * @returns {number}
     */
    label_length(undo) {
        const ret = wasm.capturedhistory_label_length(this.__wbg_ptr, undo);
        return ret >>> 0;
    }
    /**
     * @param {boolean} undo
     * @param {number} start
     * @param {number} count
     * @returns {Uint16Array}
     */
    label_text(undo, start, count) {
        const ret = wasm.capturedhistory_label_text(this.__wbg_ptr, undo, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * @returns {number}
     */
    redo_count() {
        const ret = wasm.capturedhistory_redo_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @returns {number}
     */
    undo_count() {
        const ret = wasm.capturedhistory_undo_count(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) CapturedHistory.prototype[Symbol.dispose] = CapturedHistory.prototype.free;

export class CapturedProject {
    static __wrap(ptr) {
        const obj = Object.create(CapturedProject.prototype);
        obj.__wbg_ptr = ptr;
        CapturedProjectFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CapturedProjectFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_capturedproject_free(ptr, 0);
    }
    /**
     * Explicit bulk export, not a per-edit projection. A hard caller-supplied
     * output budget applies during writing. This synchronous operation must not
     * run on a production authority worker until task isolation is provided.
     * @param {number} max_bytes
     * @returns {ProjectBytes}
     */
    export_json(max_bytes) {
        const ret = wasm.capturedproject_export_json(this.__wbg_ptr, max_bytes);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectBytes.__wrap(ret[0]);
    }
    /**
     * A selection's assignable scopes, unsupported refs and offered
     * filaments (`filamentAssignmentExchange`): `{"refs"}` in,
     * `{"options","scopes","unsupportedSelection"}` or `{"error"}` out.
     * @param {string} request
     * @returns {string}
     */
    filament_assignment(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_filament_assignment(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The assignments a filament choice makes (`filamentAssignmentChangesExchange`):
     * `{"entities","filamentId"}` in, `{"assignments"}` or `{"error"}` out.
     * @param {string} request
     * @returns {string}
     */
    filament_assignment_changes(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_filament_assignment_changes(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The filament slots this project's physical filaments describe
     * (`projectFilamentSlotsExchange`): `{"palette"}` in,
     * `{"heads","nozzles","palette"}` out.
     * @param {string} request
     * @returns {string}
     */
    filament_slots(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_filament_slots(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    hash() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.capturedproject_hash(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {number} start
     * @param {number} count
     * @returns {Uint16Array}
     */
    id(start, count) {
        const ret = wasm.capturedproject_id(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * @returns {number}
     */
    id_length() {
        const ret = wasm.capturedproject_id_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * One object's height ranges as the semantic editor shows them
     * (`layerRangeEditorExchange`): `{"objectId","selectedLayerRangeId"}` in,
     * `{"projection"}` out.
     * @param {string} request
     * @returns {string}
     */
    layer_range_editor(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_layer_range_editor(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * An `ObjectTreeRequest`; returns an `ObjectTreeReply`: one page of the
     * Objects tree's visible rows, or the selection activating a row commits.
     * The folder folds non-ASCII search text as the settings search does.
     * @param {string} request
     * @param {any | null} [folder]
     * @returns {string}
     */
    object_tree(request, folder) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_object_tree(this.__wbg_ptr, ptr0, len0, isLikeNone(folder) ? 0 : addToExternrefTable0(folder));
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `PaintPaletteRequest`; returns the project's `PaintPalette`.
     * @param {string} request
     * @returns {string}
     */
    paint_palette(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_paint_palette(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The print configuration plate `plate_id` (a JSON string) overrides, as
     * the canonical JSON object of engine wire strings a slice submission's
     * `overrides` field carries; an unknown plate overrides nothing.
     * @param {string} plate_id
     * @returns {string}
     */
    plate_print_overrides(plate_id) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(plate_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_plate_print_overrides(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {number} version
     * @returns {ProjectQueryNode}
     */
    query(version) {
        const ret = wasm.capturedproject_query(this.__wbg_ptr, version);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectQueryNode.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    revision() {
        const ret = wasm.capturedproject_revision(this.__wbg_ptr);
        return ret;
    }
    /**
     * A `SettingsSessionRequest`: the settings editor for one node, whose
     * commits become guarded project intents.
     * @param {string} request
     * @param {any | null} [collator]
     * @param {any | null} [folder]
     * @returns {SettingsEditor}
     */
    settings_editor(request, collator, folder) {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.capturedproject_settings_editor(this.__wbg_ptr, ptr0, len0, isLikeNone(collator) ? 0 : addToExternrefTable0(collator), isLikeNone(folder) ? 0 : addToExternrefTable0(folder));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return SettingsEditor.__wrap(ret[0]);
    }
    /**
     * A `SettingsExplainRequest`; returns a `SettingsExplainResult`.
     * @param {string} request
     * @returns {string}
     */
    settings_explain(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_settings_explain(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `SettingsTargetRequest`; returns a `SettingsSnapshotResult`.
     * @param {string} request
     * @returns {string}
     */
    settings_snapshot(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_settings_snapshot(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `SettingsTargetPageRequest`; returns a `SettingsTargetPage`.
     * @param {string} request
     * @returns {string}
     */
    settings_targets(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_settings_targets(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The plates a slice of `scope` (`current-plate` or `all-plates`)
     * slices: `{"plateIds"}` in slicing order, or the browser's `{"refusal"}`
     * (`orcaxr_project::slicing::plate::slice_plan`).
     * @param {string} scope
     * @returns {string}
     */
    slice_plan(scope) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(scope, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_slice_plan(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The profile snapshot the plate (`plateId` as JSON text) is sliced
     * with, or the browser's `{"error"}`
     * (`orcaxr_project::slicing::sidecar::profiles`).
     * @param {string} plate_id
     * @returns {string}
     */
    slice_profiles(plate_id) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(plate_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_slice_profiles(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * What a split would split (`splitSourceExchange`):
     * `{"instanceId","target","triangleLimit"}` in, `{"source"}` or
     * `{"refusal"}` out (`orcaxr_project::split::source`).
     * @param {string} request
     * @returns {string}
     */
    split_source(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_split_source(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The virtual filament library this project shows
     * (`virtualFilamentLibraryExchange`): `{}` in,
     * `{"matchCandidates","mixedRows","physicalChoices","status"}` or `{"error"}` out.
     * @param {string} request
     * @returns {string}
     */
    virtual_filament_library(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_virtual_filament_library(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The step one library edit submits (`virtualFilamentMutationExchange`):
     * `{"operation",...}` in, `{"batchJson","label","operation","step",...}`
     * or `{"error"}` out.
     * @param {string} request
     * @returns {string}
     */
    virtual_filament_mutation(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_virtual_filament_mutation(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The bed the workspace reads from this project and plate `plateId`'s
     * tower keep-out: `{"plateId": string | null}` in, the workspace bed
     * document (`orcaxr_project::placement::bed`) out.
     * @param {string} request
     * @returns {string}
     */
    workspace_bed(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.capturedproject_workspace_bed(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) CapturedProject.prototype[Symbol.dispose] = CapturedProject.prototype.free;

export class CapturedSelection {
    static __wrap(ptr) {
        const obj = Object.create(CapturedSelection.prototype);
        obj.__wbg_ptr = ptr;
        CapturedSelectionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        CapturedSelectionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_capturedselection_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    count() {
        const ret = wasm.capturedselection_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} position
     * @param {number} start
     * @param {number} count
     * @returns {Uint16Array}
     */
    id(position, start, count) {
        const ret = wasm.capturedselection_id(this.__wbg_ptr, position, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * @param {number} position
     * @returns {number}
     */
    id_length(position) {
        const ret = wasm.capturedselection_id_length(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} position
     * @returns {number}
     */
    kind(position) {
        const ret = wasm.capturedselection_kind(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @returns {number}
     */
    primary_index() {
        const ret = wasm.capturedselection_primary_index(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) CapturedSelection.prototype[Symbol.dispose] = CapturedSelection.prototype.free;

/**
 * The hold-to-confirm gesture; each call takes the host's clock.
 */
export class HoldToConfirm {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        HoldToConfirmFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_holdtoconfirm_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    cancel() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.holdtoconfirm_cancel(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    constructor() {
        const ret = wasm.holdtoconfirm_new();
        this.__wbg_ptr = ret;
        HoldToConfirmFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @param {number} now_ms
     * @returns {string}
     */
    poll(now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.holdtoconfirm_poll(this.__wbg_ptr, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * A `GuardedPrinterAction`; the `HoldToConfirmState`.
     * @param {string} action
     * @param {number} now_ms
     * @returns {string}
     */
    press(action, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(action, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.holdtoconfirm_press(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The `HoldToConfirmRelease`: the command to run, if the hold was long enough.
     * @param {number} now_ms
     * @returns {string}
     */
    release(now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.holdtoconfirm_release(this.__wbg_ptr, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) HoldToConfirm.prototype[Symbol.dispose] = HoldToConfirm.prototype.free;

/**
 * The Moonraker transport (`MoonrakerTransport`): one printer's connection
 * and every request on it. Stepping calls answer a `MoonrakerTransportStep`.
 */
export class MoonrakerTransport {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        MoonrakerTransportFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_moonrakertransport_free(ptr, 0);
    }
    /**
     * The live signal of task `task` aborts.
     * @param {number} task
     * @param {number} now_ms
     * @returns {string}
     */
    abort(task, now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_abort(this.__wbg_ptr, task, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} now_ms
     */
    clear_credentials(now_ms) {
        wasm.moonrakertransport_clear_credentials(this.__wbg_ptr, now_ms);
    }
    /**
     * No object subscription.
     * @param {number} now_ms
     * @returns {string}
     */
    clear_subscription(now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_clear_subscription(this.__wbg_ptr, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * A `MoonrakerTransportConfig`; the `MoonrakerTransportReply` creating a
     * transport from it answers: its first state, or why it is refused.
     * @param {string} config
     * @returns {string}
     */
    static configure(config) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(config, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_configure(ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A signal by name: `none`, `live` or `aborted`.
     * @param {string} signal
     * @param {number} now_ms
     * @returns {string}
     */
    connect(signal, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(signal, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_connect(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A reason by name: `user`, `cancelled` or `disposed`.
     * @param {string} reason
     * @param {number} now_ms
     * @returns {string}
     */
    disconnect(reason, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(reason, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_disconnect(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {number} now_ms
     * @returns {string}
     */
    dispose(now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_dispose(this.__wbg_ptr, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * A `MoonrakerRequest` read as bytes.
     * @param {string} request
     * @param {number} now_ms
     * @returns {string}
     */
    download(request, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_download(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @returns {boolean}
     */
    has_api_key() {
        const ret = wasm.moonrakertransport_has_api_key(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    has_bearer_token() {
        const ret = wasm.moonrakertransport_has_bearer_token(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Past this many UTF-16 units, text decides outcomes by its length
     * alone: pass at most one unit more.
     * @returns {number}
     */
    static max_text_units() {
        const ret = wasm.moonrakertransport_max_text_units();
        return ret;
    }
    /**
     * A `MoonrakerTransportConfig` that `configure` accepts.
     * @param {string} config
     */
    constructor(config) {
        const ptr0 = passStringToWasm0(config, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonrakertransport_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        MoonrakerTransportFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * A `MoonrakerRecoveryRequest`.
     * @param {string} request
     * @param {number} now_ms
     * @returns {string}
     */
    recovery(request, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_recovery(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `MoonrakerRequest`.
     * @param {string} request
     * @param {number} now_ms
     * @returns {string}
     */
    request(request, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_request(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `MoonrakerTransportOutcome` answering effect `id`.
     * @param {number} id
     * @param {string} outcome
     * @param {number} now_ms
     * @returns {string}
     */
    resolve(id, outcome, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(outcome, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_resolve(this.__wbg_ptr, id, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A body read as text, answering effect `id`.
     * @param {number} id
     * @param {string} text
     * @param {number} now_ms
     * @returns {string}
     */
    resolve_text(id, text, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_resolve_text(this.__wbg_ptr, id, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * `MoonrakerCredentials`; an `OptionalMoonrakerTransportFault`.
     * @param {string} credentials
     * @param {number} now_ms
     * @returns {string}
     */
    set_credentials(credentials, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(credentials, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_set_credentials(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `MoonrakerObjectSubscription`; the `MoonrakerTransportStepReply`.
     * @param {string} entries
     * @param {number} now_ms
     * @returns {string}
     */
    set_subscription(entries, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(entries, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_set_subscription(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {number} socket
     * @param {number} now_ms
     * @returns {string}
     */
    socket_close(socket, now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_socket_close(this.__wbg_ptr, socket, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} socket
     * @param {number} now_ms
     * @returns {string}
     */
    socket_error(socket, now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_socket_error(this.__wbg_ptr, socket, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * A text frame socket `socket` received.
     * @param {number} socket
     * @param {string} text
     * @param {number} now_ms
     * @returns {string}
     */
    socket_message(socket, text, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_socket_message(this.__wbg_ptr, socket, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {number} socket
     * @param {number} now_ms
     * @returns {string}
     */
    socket_open(socket, now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_socket_open(this.__wbg_ptr, socket, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The `MoonrakerConnectionState`.
     * @returns {string}
     */
    state() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_state(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The JSON text of notification `id`'s params, once.
     * @param {number} id
     * @returns {string}
     */
    take_params(id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_take_params(this.__wbg_ptr, id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The JSON text of finished task `task`'s result, once.
     * @param {number} task
     * @returns {string}
     */
    take_result(task) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_take_result(this.__wbg_ptr, task);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Timer `timer` fired.
     * @param {number} timer
     * @param {number} now_ms
     * @returns {string}
     */
    timer(timer, now_ms) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.moonrakertransport_timer(this.__wbg_ptr, timer, now_ms);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * A `MoonrakerRequest` whose body is the host's file.
     * @param {string} request
     * @param {number} now_ms
     * @returns {string}
     */
    upload(request, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.moonrakertransport_upload(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) MoonrakerTransport.prototype[Symbol.dispose] = MoonrakerTransport.prototype.free;

/**
 * Installed printers and custom presets over a pinned catalog.
 */
export class PresetLibrary {
    static __wrap(ptr) {
        const obj = Object.create(PresetLibrary.prototype);
        obj.__wbg_ptr = ptr;
        PresetLibraryFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PresetLibraryFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_presetlibrary_free(ptr, 0);
    }
    /**
     * A `LibraryOperation`; returns its `LibraryOutcome`.
     * @param {string} operation
     * @returns {string}
     */
    apply(operation) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.presetlibrary_apply(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Consume an upload and move onto it; returns a `LibraryOutcome`.
     * @param {ProfileCatalogUpload} next
     * @returns {string}
     */
    apply_update(next) {
        let deferred2_0;
        let deferred2_1;
        try {
            _assertClass(next, ProfileCatalogUpload);
            const ret = wasm.presetlibrary_apply_update(this.__wbg_ptr, next.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * A `LibraryBaseRequest`; returns `LibraryBases`.
     * @param {string} request
     * @returns {string}
     */
    bases(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.presetlibrary_bases(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The composed catalog, as the profile catalog the app reads.
     * @returns {ProfileCatalog}
     */
    catalog() {
        const ret = wasm.presetlibrary_catalog(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProfileCatalog.__wrap(ret[0]);
    }
    /**
     * Consume `upload` as the system catalog. `stored` is the text the host
     * saved, if any; `limits` (bytes, nodes, text units, number bytes, depth)
     * bound reading it. Without a collator the exact ASCII root order applies.
     * @param {ProfileCatalogUpload} upload
     * @param {Uint8Array | null | undefined} stored
     * @param {Float64Array} limits
     * @param {any | null} [collator]
     * @returns {PresetLibrary}
     */
    static create(upload, stored, limits, collator) {
        _assertClass(upload, ProfileCatalogUpload);
        var ptr0 = isLikeNone(stored) ? 0 : passArray8ToWasm0(stored, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(limits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.presetlibrary_create(upload.__wbg_ptr, ptr0, len0, ptr1, len1, isLikeNone(collator) ? 0 : addToExternrefTable0(collator));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return PresetLibrary.__wrap(ret[0]);
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    custom_preset(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.presetlibrary_custom_preset(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The bundle to hand the operator, as UTF-8.
     * @param {string} exported_at
     * @param {number} max_bytes
     * @returns {Uint8Array}
     */
    export_bundle(exported_at, max_bytes) {
        const ptr0 = passStringToWasm0(exported_at, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.presetlibrary_export_bundle(this.__wbg_ptr, ptr0, len0, max_bytes);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * A bundle's bytes; returns its `LibraryOutcome`.
     * @param {Uint8Array} bundle
     * @param {Float64Array} limits
     * @returns {string}
     */
    import_bundle(bundle, limits) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passArray8ToWasm0(bundle, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF64ToWasm0(limits, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.presetlibrary_import_bundle(this.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    inventory() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.presetlibrary_inventory(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The latest outcome's issue at `position`, as a `LibraryIssue`.
     * @param {number} position
     * @returns {string}
     */
    issue(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.presetlibrary_issue(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    issue_count() {
        const ret = wasm.presetlibrary_issue_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Consume an upload of a newer catalog; returns a `LibraryUpdatePlan`.
     * @param {ProfileCatalogUpload} next
     * @returns {string}
     */
    plan_update(next) {
        let deferred2_0;
        let deferred2_1;
        try {
            _assertClass(next, ProfileCatalogUpload);
            const ret = wasm.presetlibrary_plan_update(this.__wbg_ptr, next.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The text to store, as UTF-8.
     * @param {number} max_bytes
     * @returns {Uint8Array}
     */
    state(max_bytes) {
        const ret = wasm.presetlibrary_state(this.__wbg_ptr, max_bytes);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {string}
     */
    view() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.presetlibrary_view(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) PresetLibrary.prototype[Symbol.dispose] = PresetLibrary.prototype.free;

/**
 * The print job status model: fed `/printer/objects/query` results and
 * `notify_status_update` params as received, it answers `PrintJobSnapshot`s.
 */
export class PrintJobStatus {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PrintJobStatusFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_printjobstatus_free(ptr, 0);
    }
    /**
     * `undefined` when the patch concerns no object the model reads.
     * @param {string} text
     * @param {number} now_ms
     * @returns {string | undefined}
     */
    apply_notification(text, now_ms) {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printjobstatus_apply_notification(this.__wbg_ptr, ptr0, len0, now_ms);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v2;
        if (ret[0] !== 0) {
            v2 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v2;
    }
    /**
     * @param {string} text
     * @param {number} now_ms
     * @returns {string}
     */
    apply_query(text, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printjobstatus_apply_query(this.__wbg_ptr, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    constructor() {
        const ret = wasm.printjobstatus_new();
        this.__wbg_ptr = ret;
        PrintJobStatusFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * @returns {string}
     */
    reset() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printjobstatus_reset(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    snapshot() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printjobstatus_snapshot(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) PrintJobStatus.prototype[Symbol.dispose] = PrintJobStatus.prototype.free;

/**
 * The print submission workflow (`PrintWorkflowController`): a send or a
 * stored reprint, one `PrintWorkflowStep` per call. Each step names the
 * effects the host carries out and answers by id.
 */
export class PrintWorkflow {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PrintWorkflowFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_printworkflow_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    busy() {
        const ret = wasm.printworkflow_busy(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {string}
     */
    cancel() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printworkflow_cancel(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    dispose() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printworkflow_dispose(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    constructor() {
        const ret = wasm.printworkflow_new();
        this.__wbg_ptr = ret;
        PrintWorkflowFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * A `PrintWorkflowOutcome` answering effect `id`.
     * @param {number} id
     * @param {string} outcome
     * @returns {string}
     */
    resolve(id, outcome) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(outcome, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printworkflow_resolve(this.__wbg_ptr, id, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The reply a request or upload received: Moonraker's `result`, as JSON.
     * @param {number} id
     * @param {string} text
     * @returns {string}
     */
    resolve_reply(id, text) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printworkflow_resolve_reply(this.__wbg_ptr, id, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `PrintWorkflowIntent`: send a sliced artifact.
     * @param {string} intent
     * @returns {string}
     */
    run(intent) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(intent, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printworkflow_run(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `PrinterText` naming a stored file to start.
     * @param {string} path
     * @returns {string}
     */
    start_stored(path) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(path, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printworkflow_start_stored(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) PrintWorkflow.prototype[Symbol.dispose] = PrintWorkflow.prototype.free;

/**
 * The printer session (`PrinterSessionController`): one selected printer
 * and every query, subscription and command in it. Stepping calls answer a
 * `PrinterSessionStep`; queries answer their own replies.
 */
export class PrinterSession {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        PrinterSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_printersession_free(ptr, 0);
    }
    /**
     * A command's wire name; the `PrintJobIntentReply`.
     * @param {string} command
     * @returns {string}
     */
    capture_intent(command) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(command, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printersession_capture_intent(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The `PrinterSessionLeaseReply`.
     * @returns {string}
     */
    capture_lease() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printersession_capture_lease(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    clear() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printersession_clear(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * An intent id; the `PrintJobConfirmReply`.
     * @param {number} intent
     * @returns {string}
     */
    confirm(intent) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printersession_confirm(this.__wbg_ptr, intent);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    connect() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printersession_connect(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    dispose() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printersession_dispose(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * A `PrintJobExecuteRequest`.
     * @param {string} request
     * @returns {string}
     */
    execute(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printersession_execute(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `PrinterSessionLease`; whether it is still current.
     * @param {string} lease
     * @returns {boolean}
     */
    lease_current(lease) {
        const ptr0 = passStringToWasm0(lease, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printersession_lease_current(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    constructor() {
        const ret = wasm.printersession_new();
        this.__wbg_ptr = ret;
        PrinterSessionFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * A notification's method and params (JSON) as transport `transport`
     * received them at `now_ms`.
     * @param {number} transport
     * @param {string} method
     * @param {string} params
     * @param {number} now_ms
     * @returns {string}
     */
    notification(transport, method, params, now_ms) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passStringToWasm0(method, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passStringToWasm0(params, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.printersession_notification(this.__wbg_ptr, transport, ptr0, len0, ptr1, len1, now_ms);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    refresh() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printersession_refresh(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * A `PrinterSessionOutcome` answering effect `id`.
     * @param {number} id
     * @param {string} outcome
     * @returns {string}
     */
    resolve(id, outcome) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(outcome, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printersession_resolve(this.__wbg_ptr, id, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A request's reply (Moonraker's `result`, as JSON) received at `now_ms`.
     * @param {number} id
     * @param {string} text
     * @param {number} now_ms
     * @returns {string}
     */
    resolve_reply(id, text, now_ms) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printersession_resolve_reply(this.__wbg_ptr, id, ptr0, len0, now_ms);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `PrinterSelection`.
     * @param {string} selection
     * @returns {string}
     */
    select(selection) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(selection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printersession_select(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A `ConnectionSignal` from transport `transport`.
     * @param {number} transport
     * @param {string} signal
     * @returns {string}
     */
    transport_state(transport, signal) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(signal, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.printersession_transport_state(this.__wbg_ptr, transport, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The `PrinterSessionView`: generation, snapshot and availability.
     * @returns {string}
     */
    view() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.printersession_view(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) PrinterSession.prototype[Symbol.dispose] = PrinterSession.prototype.free;

/**
 * A loaded catalog: compiled, or refused with its diagnostics.
 */
export class ProfileCatalog {
    static __wrap(ptr) {
        const obj = Object.create(ProfileCatalog.prototype);
        obj.__wbg_ptr = ptr;
        ProfileCatalogFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProfileCatalogFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_profilecatalog_free(ptr, 0);
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    diagnostic(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.profilecatalog_diagnostic(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    diagnostic_count() {
        const ret = wasm.profilecatalog_diagnostic_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * `CatalogTargetRequest` in, the `CatalogPreflightTarget` of a
     * `PreflightRequest` out. More than `max_tools` tools is refused.
     * @param {string} target
     * @param {number} max_tools
     * @returns {string}
     */
    preflight_target(target, max_tools) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(target, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profilecatalog_preflight_target(this.__wbg_ptr, ptr0, len0, max_tools);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    preset(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.profilecatalog_preset(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    preset_count() {
        const ret = wasm.profilecatalog_preset_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    profile(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.profilecatalog_profile(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    profile_config(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.profilecatalog_profile_config(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    profile_count() {
        const ret = wasm.profilecatalog_profile_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * `CatalogSelectionRequest` in, `CatalogSelection` out.
     * @param {string} selection
     * @returns {string}
     */
    reconcile(selection) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(selection, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profilecatalog_reconcile(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The pickers' choices (`slicingChoicesExchange`): canonical JSON
     * `{"machinePresetId"?, "processPresetId"?}` in, `{"machines",
     * "processes","filaments"}` of `{"id","label","name"}` out.
     * @param {string} request
     * @returns {string}
     */
    slicing_choices(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profilecatalog_slicing_choices(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A live choice's slicing configuration against a state document,
     * admitted under the host's `Date.parse` (`slicingConfigurationExchange`).
     * @param {string} request
     * @returns {string}
     */
    slicing_configuration(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profilecatalog_slicing_configuration(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The catalog's default triple selected (`defaultProfileSelectionExchange`).
     * @param {string} request
     * @returns {string}
     */
    slicing_default(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profilecatalog_slicing_default(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A selection by preset ID from a live choice (`profileSelectionExchange`):
     * `{"live","request"}` in, `{"feedback","live"?}` out.
     * @param {string} request
     * @returns {string}
     */
    slicing_select(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profilecatalog_slicing_select(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A selection by typed names (`profileSelectionByNamesExchange`).
     * @param {string} request
     * @returns {string}
     */
    slicing_select_by_names(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profilecatalog_slicing_select_by_names(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * One edit of a live choice's filament slots (`filamentSlotsExchange`):
     * `{"edit","live"}` in, `{"live"}`, `{"unchanged":true}` or
     * `{"error":"slot-limit","message"}` out.
     * @param {string} request
     * @returns {string}
     */
    slicing_slots(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.profilecatalog_slicing_slots(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) ProfileCatalog.prototype[Symbol.dispose] = ProfileCatalog.prototype.free;

/**
 * Own in a task worker; `build` consumes it.
 */
export class ProfileCatalogUpload {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProfileCatalogUploadFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_profilecatalogupload_free(ptr, 0);
    }
    /**
     * @param {number} offset
     * @param {Uint8Array} bytes
     */
    append(offset, bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.profilecatalogupload_append(this.__wbg_ptr, offset, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Build the catalog. Without a collator the core's exact ASCII root
     * collation orders presets and refuses any other text.
     * @param {any | null} [collator]
     * @returns {ProfileCatalog}
     */
    build(collator) {
        const ret = wasm.profilecatalogupload_build(this.__wbg_ptr, isLikeNone(collator) ? 0 : addToExternrefTable0(collator));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProfileCatalog.__wrap(ret[0]);
    }
    /**
     * `limits`: maximum bytes, nodes, text units, number bytes and depth.
     * @param {number} bytes
     * @param {Float64Array} limits
     */
    constructor(bytes, limits) {
        const ptr0 = passArrayF64ToWasm0(limits, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.profilecatalogupload_new(bytes, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ProfileCatalogUploadFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ProfileCatalogUpload.prototype[Symbol.dispose] = ProfileCatalogUpload.prototype.free;

export class ProjectArchiveImport {
    static __wrap(ptr) {
        const obj = Object.create(ProjectArchiveImport.prototype);
        obj.__wbg_ptr = ptr;
        ProjectArchiveImportFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectArchiveImportFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectarchiveimport_free(ptr, 0);
    }
    /**
     * Takes the prepared document once for guarded adoption.
     * @returns {ProjectDocument}
     */
    document() {
        const ret = wasm.projectarchiveimport_document(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectDocument.__wrap(ret[0]);
    }
    /**
     * `FORMAT_CANONICAL` or `FORMAT_FOREIGN` from the generated layout.
     * @returns {number}
     */
    format() {
        const ret = wasm.projectarchiveimport_format(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Bounded UTF-16 reads; lone surrogates survive.
     * @param {number} position
     * @param {number} start
     * @param {number} count
     * @returns {Uint16Array}
     */
    warning(position, start, count) {
        const ret = wasm.projectarchiveimport_warning(this.__wbg_ptr, position, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * The browser's sorted, unique warning texts.
     * @returns {number}
     */
    warning_count() {
        const ret = wasm.projectarchiveimport_warning_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} position
     * @returns {number}
     */
    warning_length(position) {
        const ret = wasm.projectarchiveimport_warning_length(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
}
if (Symbol.dispose) ProjectArchiveImport.prototype[Symbol.dispose] = ProjectArchiveImport.prototype.free;

export class ProjectArchiveOutput {
    static __wrap(ptr) {
        const obj = Object.create(ProjectArchiveOutput.prototype);
        obj.__wbg_ptr = ptr;
        ProjectArchiveOutputFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectArchiveOutputFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectarchiveoutput_free(ptr, 0);
    }
    /**
     * The checkpoint guard of the written capture, taken once; an export
     * capture's archive has none. Acknowledge it only after the host confirms
     * the save handoff.
     * @returns {ProjectGuard}
     */
    guard() {
        const ret = wasm.projectarchiveoutput_guard(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectGuard.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    length() {
        const ret = wasm.projectarchiveoutput_length(this.__wbg_ptr);
        return ret;
    }
    /**
     * Copies one bounded chunk into host-owned memory.
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    read(start, count) {
        const ret = wasm.projectarchiveoutput_read(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {number} position
     * @param {number} start
     * @param {number} count
     * @returns {Uint16Array}
     */
    warning(position, start, count) {
        const ret = wasm.projectarchiveoutput_warning(this.__wbg_ptr, position, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * @returns {number}
     */
    warning_count() {
        const ret = wasm.projectarchiveoutput_warning_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} position
     * @returns {number}
     */
    warning_length(position) {
        const ret = wasm.projectarchiveoutput_warning_length(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
}
if (Symbol.dispose) ProjectArchiveOutput.prototype[Symbol.dispose] = ProjectArchiveOutput.prototype.free;

export class ProjectArchiveUpload {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectArchiveUploadFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectarchiveupload_free(ptr, 0);
    }
    /**
     * Offsets make retries and out-of-order delivery explicit; a refused
     * chunk is not consumed.
     * @param {number} offset
     * @param {Uint8Array} chunk
     */
    append(offset, chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectarchiveupload_append(this.__wbg_ptr, offset, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * `archive_bytes` is the exact length, reserved up front after checking it
     * against the policy; omit it for open-ended input bounded by the policy.
     * @param {number} version
     * @param {number | null | undefined} archive_bytes
     * @param {Float64Array} policy
     */
    constructor(version, archive_bytes, policy) {
        const ptr0 = passArrayF64ToWasm0(policy, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectarchiveupload_new(version, !isLikeNone(archive_bytes), isLikeNone(archive_bytes) ? 0 : archive_bytes, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ProjectArchiveUploadFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Consumes the upload on every outcome. Completes import privately: no
     * session state changes until the host adopts the returned document.
     * @returns {ProjectArchiveImport}
     */
    prepare() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.projectarchiveupload_prepare(ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectArchiveImport.__wrap(ret[0]);
    }
}
if (Symbol.dispose) ProjectArchiveUpload.prototype[Symbol.dispose] = ProjectArchiveUpload.prototype.free;

export class ProjectAsset {
    static __wrap(ptr) {
        const obj = Object.create(ProjectAsset.prototype);
        obj.__wbg_ptr = ptr;
        ProjectAssetFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectAssetFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectasset_free(ptr, 0);
    }
    /**
     * @returns {string}
     */
    digest() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.projectasset_digest(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {number}
     */
    length() {
        const ret = wasm.projectasset_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} max_bytes
     * @returns {ProjectBytes}
     */
    metadata(max_bytes) {
        const ret = wasm.projectasset_metadata(this.__wbg_ptr, max_bytes);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectBytes.__wrap(ret[0]);
    }
    /**
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    read(start, count) {
        const ret = wasm.projectasset_read(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) ProjectAsset.prototype[Symbol.dispose] = ProjectAsset.prototype.free;

export class ProjectBytes {
    static __wrap(ptr) {
        const obj = Object.create(ProjectBytes.prototype);
        obj.__wbg_ptr = ptr;
        ProjectBytesFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectBytesFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectbytes_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    length() {
        const ret = wasm.projectbytes_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    read(start, count) {
        const ret = wasm.projectbytes_read(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) ProjectBytes.prototype[Symbol.dispose] = ProjectBytes.prototype.free;

export class ProjectClipboard {
    static __wrap(ptr) {
        const obj = Object.create(ProjectClipboard.prototype);
        obj.__wbg_ptr = ptr;
        ProjectClipboardFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectClipboardFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectclipboard_free(ptr, 0);
    }
    /**
     * Counts for allocating new editable IDs. Bytes and the source object stay
     * inside native ownership; free this host handle when replacing the copy.
     * @returns {Float64Array}
     */
    info() {
        const ret = wasm.projectclipboard_info(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
}
if (Symbol.dispose) ProjectClipboard.prototype[Symbol.dispose] = ProjectClipboard.prototype.free;

/**
 * Explicit preparation owner. Cancellation drops parsed/sealed input and the
 * guard immediately; dropping/freeing the owner does the same. Use a separate
 * task for seal(). Session disposal invalidates admission, not captured input.
 */
export class ProjectCommandUpload {
    static __wrap(ptr) {
        const obj = Object.create(ProjectCommandUpload.prototype);
        obj.__wbg_ptr = ptr;
        ProjectCommandUploadFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectCommandUploadFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectcommandupload_free(ptr, 0);
    }
    /**
     * @param {number} offset
     * @param {Uint8Array} bytes
     */
    append(offset, bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectcommandupload_append(this.__wbg_ptr, offset, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} offset
     * @param {Uint8Array} bytes
     */
    append_asset(offset, bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectcommandupload_append_asset(this.__wbg_ptr, offset, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Payload bytes the sealed work holds (each distinct payload once).
     * @returns {number}
     */
    asset_bytes() {
        const ret = wasm.projectcommandupload_asset_bytes(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Payloads the sealed records declared, in first-declaration order.
     * @returns {number}
     */
    asset_count() {
        const ret = wasm.projectcommandupload_asset_count(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Start one declared payload; returns its exact byte length.
     * @param {number} position
     * @returns {number}
     */
    begin_asset(position) {
        const ret = wasm.projectcommandupload_begin_asset(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    cancel() {
        wasm.projectcommandupload_cancel(this.__wbg_ptr);
    }
    cancel_asset() {
        wasm.projectcommandupload_cancel_asset(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    command_count() {
        const ret = wasm.projectcommandupload_command_count(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Validates the payload; the last one prepares the work's commands.
     */
    finish_asset() {
        const ret = wasm.projectcommandupload_finish_asset(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    seal() {
        const ret = wasm.projectcommandupload_seal(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {number}
     */
    units() {
        const ret = wasm.projectcommandupload_units(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
}
if (Symbol.dispose) ProjectCommandUpload.prototype[Symbol.dispose] = ProjectCommandUpload.prototype.free;

/**
 * Admission consumes the contents on every outcome. Free the empty wrapper
 * afterwards; reusing its consumed contents returns invalid_state.
 */
export class ProjectDocument {
    static __wrap(ptr) {
        const obj = Object.create(ProjectDocument.prototype);
        obj.__wbg_ptr = ptr;
        ProjectDocumentFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectDocumentFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectdocument_free(ptr, 0);
    }
}
if (Symbol.dispose) ProjectDocument.prototype[Symbol.dispose] = ProjectDocument.prototype.free;

export class ProjectEffects {
    static __wrap(ptr) {
        const obj = Object.create(ProjectEffects.prototype);
        obj.__wbg_ptr = ptr;
        ProjectEffectsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectEffectsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projecteffects_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    count() {
        const ret = wasm.projecteffects_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    dirty_categories(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projecteffects_dirty_categories(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} position
     * @param {boolean} previous
     * @returns {CapturedHistory}
     */
    history(position, previous) {
        const ret = wasm.projecteffects_history(this.__wbg_ptr, position, previous);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CapturedHistory.__wrap(ret[0]);
    }
    /**
     * @param {number} position
     * @returns {number}
     */
    kind(position) {
        const ret = wasm.projecteffects_kind(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} position
     * @param {boolean} previous
     * @returns {CapturedProject}
     */
    project(position, previous) {
        const ret = wasm.projecteffects_project(this.__wbg_ptr, position, previous);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CapturedProject.__wrap(ret[0]);
    }
    /**
     * @param {number} position
     * @param {number} start
     * @param {number} count
     * @returns {Uint16Array}
     */
    reason(position, start, count) {
        const ret = wasm.projecteffects_reason(this.__wbg_ptr, position, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * @param {number} position
     * @returns {number}
     */
    reason_length(position) {
        const ret = wasm.projecteffects_reason_length(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} position
     * @param {boolean} previous
     * @returns {CapturedSelection}
     */
    selection(position, previous) {
        const ret = wasm.projecteffects_selection(this.__wbg_ptr, position, previous);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return CapturedSelection.__wrap(ret[0]);
    }
}
if (Symbol.dispose) ProjectEffects.prototype[Symbol.dispose] = ProjectEffects.prototype.free;

/**
 * One emboss cut, prepared from a recipe and the host's glyph outlines.
 */
export class ProjectEmboss {
    static __wrap(ptr) {
        const obj = Object.create(ProjectEmboss.prototype);
        obj.__wbg_ptr = ptr;
        ProjectEmbossFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectEmbossFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectemboss_free(ptr, 0);
    }
    /**
     * Bytes `start..start + count` of the cut's indexed-mesh payload.
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    mesh(start, count) {
        const ret = wasm.projectemboss_mesh(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The `EmbossReply`: the cut's summary, or the refusal.
     * @returns {string}
     */
    reply() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectemboss_reply(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectEmboss.prototype[Symbol.dispose] = ProjectEmboss.prototype.free;

export class ProjectExport {
    static __wrap(ptr) {
        const obj = Object.create(ProjectExport.prototype);
        obj.__wbg_ptr = ptr;
        ProjectExportFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectExportFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectexport_free(ptr, 0);
    }
    /**
     * The one-plate slice capture of `plate_id` (a JSON string): this
     * capture's project reduced to that plate as plate zero with only the
     * assets it keeps, admitted under the host's `Date.parse`, for
     * `write_archive` to package as the archive an external slicer loads.
     * Refused with `plate_projection_*` codes.
     * @param {string} plate_id
     * @returns {ProjectExport}
     */
    plate(plate_id) {
        const ptr0 = passStringToWasm0(plate_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectexport_plate(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectExport.__wrap(ret[0]);
    }
    /**
     * Live slice preflight of exactly this frozen bundle from a contract
     * `PreflightRequest`. Synchronous; run it on a worker.
     * @param {string} request
     * @returns {ProjectPreflight}
     */
    preflight(request) {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectexport_preflight(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectPreflight.__wrap(ret[0]);
    }
    /**
     * The captured project: for a plate's capture, the projected one, whose
     * hash is its archive's `sourceHash`.
     * @returns {CapturedProject}
     */
    project() {
        const ret = wasm.projectexport_project(this.__wbg_ptr);
        return CapturedProject.__wrap(ret);
    }
    /**
     * The pictures this capture's project asks for (its `thumbnails`),
     * drawn from its active plate — a plate capture's only one — by the
     * shared core (`orcaxr_archive::thumbnail`), each as the G-code block
     * that carries it: `{"problems","thumbnails":[{"block","coverage",
     * "format","height","width"}]}`. Synchronous; run it on a worker.
     * @returns {string}
     */
    thumbnails() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectexport_thumbnails(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Write this frozen capture — a plate's, for an external slicer — as a
     * complete 3MF package. It carries no checkpoint guard: an export is
     * never a save.
     * @param {number} version
     * @param {Float64Array} policy
     * @returns {ProjectArchiveOutput}
     */
    write_archive(version, policy) {
        const ptr0 = passArrayF64ToWasm0(policy, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectexport_write_archive(this.__wbg_ptr, version, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectArchiveOutput.__wrap(ret[0]);
    }
}
if (Symbol.dispose) ProjectExport.prototype[Symbol.dispose] = ProjectExport.prototype.free;

export class ProjectGuard {
    static __wrap(ptr) {
        const obj = Object.create(ProjectGuard.prototype);
        obj.__wbg_ptr = ptr;
        ProjectGuardFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectGuardFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectguard_free(ptr, 0);
    }
}
if (Symbol.dispose) ProjectGuard.prototype[Symbol.dispose] = ProjectGuard.prototype.free;

/**
 * The base an import is prepared against: guard, snapshot and asset copies.
 */
export class ProjectImportBase {
    static __wrap(ptr) {
        const obj = Object.create(ProjectImportBase.prototype);
        obj.__wbg_ptr = ptr;
        ProjectImportBaseFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectImportBaseFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectimportbase_free(ptr, 0);
    }
    /**
     * Consumes the upload on every outcome. `bed` is empty or the printable
     * area `[x_min, y_min, x_max, y_max]` in printer millimetres. Production IDs come from a 32-byte random `id_seed`;
     * `id_namespace` selects deterministic `import:<namespace>:<kind>-<n>` IDs.
     * @param {ProjectModelUpload} upload
     * @param {Uint16Array} filename
     * @param {Uint16Array} imported_at
     * @param {Float64Array} bed
     * @param {boolean} drop_to_bed
     * @param {Uint8Array} id_seed
     * @param {string | null} [id_namespace]
     * @returns {ProjectImportPreview}
     */
    prepare_model(upload, filename, imported_at, bed, drop_to_bed, id_seed, id_namespace) {
        _assertClass(upload, ProjectModelUpload);
        var ptr0 = upload.__destroy_into_raw();
        const ptr1 = passArray16ToWasm0(filename, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray16ToWasm0(imported_at, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArrayF64ToWasm0(bed, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray8ToWasm0(id_seed, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        var ptr5 = isLikeNone(id_namespace) ? 0 : passStringToWasm0(id_namespace, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len5 = WASM_VECTOR_LEN;
        const ret = wasm.projectimportbase_prepare_model(this.__wbg_ptr, ptr0, ptr1, len1, ptr2, len2, ptr3, len3, drop_to_bed, ptr4, len4, ptr5, len5);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectImportPreview.__wrap(ret[0]);
    }
}
if (Symbol.dispose) ProjectImportBase.prototype[Symbol.dispose] = ProjectImportBase.prototype.free;

/**
 * The browser's preview (canonical JSON, bounded reads) and its commit token.
 */
export class ProjectImportPreview {
    static __wrap(ptr) {
        const obj = Object.create(ProjectImportPreview.prototype);
        obj.__wbg_ptr = ptr;
        ProjectImportPreviewFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectImportPreviewFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectimportpreview_free(ptr, 0);
    }
    /**
     * @returns {boolean}
     */
    blocked() {
        const ret = wasm.projectimportpreview_blocked(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * @returns {number}
     */
    length() {
        const ret = wasm.projectimportpreview_length(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    read(start, count) {
        const ret = wasm.projectimportpreview_read(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) ProjectImportPreview.prototype[Symbol.dispose] = ProjectImportPreview.prototype.free;

/**
 * One volume's features, captured for measuring.
 */
export class ProjectMeasureVolume {
    static __wrap(ptr) {
        const obj = Object.create(ProjectMeasureVolume.prototype);
        obj.__wbg_ptr = ptr;
        ProjectMeasureVolumeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectMeasureVolumeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectmeasurevolume_free(ptr, 0);
    }
    /**
     * A `MeasureFeatureRequest`; returns a `MeasureFeatureReply`.
     * @param {string} request
     * @returns {string}
     */
    feature(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectmeasurevolume_feature(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The `MeasureVolumeReply`: plane and facet counts, or the refusal.
     * @returns {string}
     */
    reply() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectmeasurevolume_reply(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectMeasureVolume.prototype[Symbol.dispose] = ProjectMeasureVolume.prototype.free;

/**
 * One mesh asset's renderer packet.
 */
export class ProjectMeshPacket {
    static __wrap(ptr) {
        const obj = Object.create(ProjectMeshPacket.prototype);
        obj.__wbg_ptr = ptr;
        ProjectMeshPacketFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectMeshPacketFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectmeshpacket_free(ptr, 0);
    }
    /**
     * Bytes `start..start + count` of the packet: the chunk table, then the
     * chunks.
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    bytes(start, count) {
        const ret = wasm.projectmeshpacket_bytes(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The `MeshPacketReply`: the packet's shape, or the refusal.
     * @returns {string}
     */
    reply() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectmeshpacket_reply(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectMeshPacket.prototype[Symbol.dispose] = ProjectMeshPacket.prototype.free;

export class ProjectModelUpload {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectModelUploadFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectmodelupload_free(ptr, 0);
    }
    /**
     * @param {number} offset
     * @param {Uint8Array} chunk
     */
    append(offset, chunk) {
        const ptr0 = passArray8ToWasm0(chunk, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectmodelupload_append(this.__wbg_ptr, offset, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * `model_bytes` is the exact length, or omitted for open-ended input; the
     * generated options are the browser's model import limits.
     * @param {number} version
     * @param {number | null | undefined} model_bytes
     * @param {Float64Array} options
     */
    constructor(version, model_bytes, options) {
        const ptr0 = passArrayF64ToWasm0(options, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectmodelupload_new(version, !isLikeNone(model_bytes), isLikeNone(model_bytes) ? 0 : model_bytes, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ProjectModelUploadFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ProjectModelUpload.prototype[Symbol.dispose] = ProjectModelUpload.prototype.free;

export class ProjectOpen {
    static __wrap(ptr) {
        const obj = Object.create(ProjectOpen.prototype);
        obj.__wbg_ptr = ptr;
        ProjectOpenFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectOpenFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectopen_free(ptr, 0);
    }
}
if (Symbol.dispose) ProjectOpen.prototype[Symbol.dispose] = ProjectOpen.prototype.free;

/**
 * One volume's paint facets: a canonical JSON summary, then packets of
 * 12-byte runs (uint32 first facet, count, state) and 44-byte leaves (nine
 * float32 corners, uint32 source facet and state), little-endian.
 */
export class ProjectPaintFacets {
    static __wrap(ptr) {
        const obj = Object.create(ProjectPaintFacets.prototype);
        obj.__wbg_ptr = ptr;
        ProjectPaintFacetsFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectPaintFacetsFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectpaintfacets_free(ptr, 0);
    }
    /**
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    leaves(start, count) {
        const ret = wasm.projectpaintfacets_leaves(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    runs(start, count) {
        const ret = wasm.projectpaintfacets_runs(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {string}
     */
    summary() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.projectpaintfacets_summary(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectPaintFacets.prototype[Symbol.dispose] = ProjectPaintFacets.prototype.free;

/**
 * One paint overlay's facets: a `PaintOverlaySummary`, then packets of
 * 40-byte facets (nine little-endian float32 corners and a uint32 state).
 */
export class ProjectPaintOverlay {
    static __wrap(ptr) {
        const obj = Object.create(ProjectPaintOverlay.prototype);
        obj.__wbg_ptr = ptr;
        ProjectPaintOverlayFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectPaintOverlayFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectpaintoverlay_free(ptr, 0);
    }
    /**
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    packet(start, count) {
        const ret = wasm.projectpaintoverlay_packet(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * @returns {string}
     */
    summary() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectpaintoverlay_summary(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectPaintOverlay.prototype[Symbol.dispose] = ProjectPaintOverlay.prototype.free;

/**
 * One paint gesture, opened on a session guard. Samples and overlay pages
 * run here, off the session; the session stages its commit.
 */
export class ProjectPaintStroke {
    static __wrap(ptr) {
        const obj = Object.create(ProjectPaintStroke.prototype);
        obj.__wbg_ptr = ptr;
        ProjectPaintStrokeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectPaintStrokeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectpaintstroke_free(ptr, 0);
    }
    /**
     * A `PaintStrokeOverlayRequest`; returns a `PaintStrokeOverlay`.
     * @param {string} request
     * @returns {string}
     */
    overlay(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectpaintstroke_overlay(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The stroke's live preview as an overlay capture.
     * @returns {ProjectPaintOverlay}
     */
    preview() {
        const ret = wasm.projectpaintstroke_preview(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectPaintOverlay.__wrap(ret[0]);
    }
    /**
     * The stroke's live preview as paint facets.
     * @returns {ProjectPaintFacets}
     */
    preview_facets() {
        const ret = wasm.projectpaintstroke_preview_facets(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectPaintFacets.__wrap(ret[0]);
    }
    /**
     * A `PaintStrokeSample`; returns a `PaintStrokeSampleReply`.
     * @param {string} request
     * @returns {string}
     */
    sample(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectpaintstroke_sample(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * One sample made with the painter's settings: `{"hit","settings"}` in,
     * `{"reply","sample"}` or the painter's `{"error","message"}` out.
     * @param {string} request
     * @returns {string}
     */
    sample_with(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectpaintstroke_sample_with(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectPaintStroke.prototype[Symbol.dispose] = ProjectPaintStroke.prototype.free;

/**
 * One plate captured for picking; build it again when the project changes.
 */
export class ProjectPickScene {
    static __wrap(ptr) {
        const obj = Object.create(ProjectPickScene.prototype);
        obj.__wbg_ptr = ptr;
        ProjectPickSceneFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectPickSceneFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectpickscene_free(ptr, 0);
    }
    /**
     * A `PickRay` in printer space; returns a `PickReply`.
     * @param {string} ray
     * @returns {string}
     */
    pick(ray) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(ray, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectpickscene_pick(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectPickScene.prototype[Symbol.dispose] = ProjectPickScene.prototype.free;

/**
 * One live preflight result, read item by item as contract JSON.
 */
export class ProjectPreflight {
    static __wrap(ptr) {
        const obj = Object.create(ProjectPreflight.prototype);
        obj.__wbg_ptr = ptr;
        ProjectPreflightFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectPreflightFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectpreflight_free(ptr, 0);
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    issue(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectpreflight_issue(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    omission(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectpreflight_omission(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    printable_instance(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectpreflight_printable_instance(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @returns {string}
     */
    summary() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectpreflight_summary(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    used_filament(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectpreflight_used_filament(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectPreflight.prototype[Symbol.dispose] = ProjectPreflight.prototype.free;

export class ProjectQueryList {
    static __wrap(ptr) {
        const obj = Object.create(ProjectQueryList.prototype);
        obj.__wbg_ptr = ptr;
        ProjectQueryListFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectQueryListFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectquerylist_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    count() {
        const ret = wasm.projectquerylist_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * @param {number} position
     * @returns {ProjectQueryNode}
     */
    node(position) {
        const ret = wasm.projectquerylist_node(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectQueryNode.__wrap(ret[0]);
    }
    /**
     * @param {number} start
     * @param {number} count
     * @returns {Float64Array}
     */
    page(start, count) {
        const ret = wasm.projectquerylist_page(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {CapturedProject}
     */
    snapshot() {
        const ret = wasm.projectquerylist_snapshot(this.__wbg_ptr);
        return CapturedProject.__wrap(ret);
    }
}
if (Symbol.dispose) ProjectQueryList.prototype[Symbol.dispose] = ProjectQueryList.prototype.free;

export class ProjectQueryNode {
    static __wrap(ptr) {
        const obj = Object.create(ProjectQueryNode.prototype);
        obj.__wbg_ptr = ptr;
        ProjectQueryNodeFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectQueryNodeFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectquerynode_free(ptr, 0);
    }
    /**
     * @param {number} relation
     * @param {number} max_sort_entries
     * @returns {ProjectQueryList}
     */
    children(relation, max_sort_entries) {
        const ret = wasm.projectquerynode_children(this.__wbg_ptr, relation, max_sort_entries);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectQueryList.__wrap(ret[0]);
    }
    /**
     * @returns {Float64Array}
     */
    metadata() {
        const ret = wasm.projectquerynode_metadata(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * @returns {CapturedProject}
     */
    snapshot() {
        const ret = wasm.projectquerynode_snapshot(this.__wbg_ptr);
        return CapturedProject.__wrap(ret);
    }
    /**
     * @param {number} field
     * @param {number} start
     * @param {number} count
     * @returns {Uint16Array}
     */
    text(field, start, count) {
        const ret = wasm.projectquerynode_text(this.__wbg_ptr, field, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU16FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 2, 2);
        return v1;
    }
    /**
     * @param {number} field
     * @returns {number}
     */
    text_length(field) {
        const ret = wasm.projectquerynode_text_length(this.__wbg_ptr, field);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
}
if (Symbol.dispose) ProjectQueryNode.prototype[Symbol.dispose] = ProjectQueryNode.prototype.free;

export class ProjectReply {
    static __wrap(ptr) {
        const obj = Object.create(ProjectReply.prototype);
        obj.__wbg_ptr = ptr;
        ProjectReplyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectReplyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectreply_free(ptr, 0);
    }
    /**
     * Consume the response to transfer all effects; retain their order even
     * when the reply reports commandFailed after rollback.
     * @returns {ProjectEffects}
     */
    effects() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.projectreply_effects(ptr);
        return ProjectEffects.__wrap(ret);
    }
    /**
     * @returns {string}
     */
    wire() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.projectreply_wire(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectReply.prototype[Symbol.dispose] = ProjectReply.prototype.free;

export class ProjectSelectionInput {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectSelectionInputFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectselectioninput_free(ptr, 0);
    }
    /**
     * @param {number} kind
     * @param {Uint16Array} id
     */
    add(kind, id) {
        const ptr0 = passArray16ToWasm0(id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectselectioninput_add(this.__wbg_ptr, kind, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    constructor() {
        const ret = wasm.projectselectioninput_new();
        this.__wbg_ptr = ret;
        ProjectSelectionInputFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ProjectSelectionInput.prototype[Symbol.dispose] = ProjectSelectionInput.prototype.free;

export class ProjectSession {
    static __wrap(ptr) {
        const obj = Object.create(ProjectSession.prototype);
        obj.__wbg_ptr = ptr;
        ProjectSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectsession_free(ptr, 0);
    }
    /**
     * Call only after the host confirms successful save handoff. Merely reading
     * or serializing a capture never clears dirty state.
     * @param {ProjectGuard} guard
     * @returns {ProjectEffects}
     */
    acknowledge_checkpoint(guard) {
        _assertClass(guard, ProjectGuard);
        const ret = wasm.projectsession_acknowledge_checkpoint(this.__wbg_ptr, guard.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectEffects.__wrap(ret[0]);
    }
    /**
     * @param {number} position
     * @returns {ProjectAsset}
     */
    asset(position) {
        const ret = wasm.projectsession_asset(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectAsset.__wrap(ret[0]);
    }
    /**
     * @returns {string}
     */
    asset_fingerprint() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.projectsession_asset_fingerprint(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @returns {ProjectOpen}
     */
    begin_open() {
        const ret = wasm.projectsession_begin_open(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectOpen.__wrap(ret[0]);
    }
    /**
     * @param {ProjectOpen} ticket
     * @returns {boolean}
     */
    cancel_open(ticket) {
        _assertClass(ticket, ProjectOpen);
        const ret = wasm.projectsession_cancel_open(this.__wbg_ptr, ticket.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * A `CapabilityRequest` against the session's current state; returns a
     * `CapabilityPage`.
     * @param {string} request
     * @returns {string}
     */
    capabilities(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_capabilities(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {ProjectGuard} guard
     * @param {ProjectQueryNode} node
     * @param {number} version
     * @param {Float64Array} options
     * @returns {ProjectClipboard}
     */
    capture_clipboard(guard, node, version, options) {
        _assertClass(guard, ProjectGuard);
        _assertClass(node, ProjectQueryNode);
        const ptr0 = passArrayF64ToWasm0(options, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_capture_clipboard(this.__wbg_ptr, guard.__wbg_ptr, node.__wbg_ptr, version, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectClipboard.__wrap(ret[0]);
    }
    /**
     * Freeze the project and its assets for an export or a live preflight.
     * @param {ProjectGuard} guard
     * @returns {ProjectExport}
     */
    capture_export(guard) {
        _assertClass(guard, ProjectGuard);
        const ret = wasm.projectsession_capture_export(this.__wbg_ptr, guard.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectExport.__wrap(ret[0]);
    }
    /**
     * @returns {ProjectGuard}
     */
    capture_guard() {
        const ret = wasm.projectsession_capture_guard(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectGuard.__wrap(ret[0]);
    }
    /**
     * @returns {ProjectImportBase}
     */
    capture_import_base() {
        const ret = wasm.projectsession_capture_import_base(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectImportBase.__wrap(ret[0]);
    }
    /**
     * @param {ProjectGuard} guard
     * @param {ProjectClipboard} clipboard
     * @param {number} version
     * @param {number} bytes
     * @param {Float64Array} options
     * @returns {ProjectCommandUpload}
     */
    clipboard_upload(guard, clipboard, version, bytes, options) {
        _assertClass(guard, ProjectGuard);
        _assertClass(clipboard, ProjectClipboard);
        const ptr0 = passArrayF64ToWasm0(options, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_clipboard_upload(this.__wbg_ptr, guard.__wbg_ptr, clipboard.__wbg_ptr, version, bytes, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectCommandUpload.__wrap(ret[0]);
    }
    /**
     * @param {ProjectGuard} guard
     * @param {number} version
     * @param {number} bytes
     * @param {Float64Array} options
     * @returns {ProjectCommandUpload}
     */
    command_upload(guard, version, bytes, options) {
        _assertClass(guard, ProjectGuard);
        const ptr0 = passArrayF64ToWasm0(options, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_command_upload(this.__wbg_ptr, guard.__wbg_ptr, version, bytes, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectCommandUpload.__wrap(ret[0]);
    }
    /**
     * Dispatch the returned effects before reporting success. A refused
     * confirmation changes nothing and keeps the candidate for a retry; any
     * later outcome consumes it.
     * @param {ProjectImportPreview} preview
     * @param {string[]} acknowledged
     * @returns {ProjectEffects}
     */
    commit_import(preview, acknowledged) {
        _assertClass(preview, ProjectImportPreview);
        const ptr0 = passArrayJsValueToWasm0(acknowledged, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_commit_import(this.__wbg_ptr, preview.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectEffects.__wrap(ret[0]);
    }
    /**
     * @param {number} version
     * @param {Float64Array} options
     */
    configure_staging(version, options) {
        const ptr0 = passArrayF64ToWasm0(options, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_configure_staging(this.__wbg_ptr, version, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The corners of one object's first layer an ear would hold down: a
     * `BrimEarDetectRequest`; returns a `BrimEarDetectReply`.
     * @param {string} request
     * @returns {string}
     */
    detect_brim_ears(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_detect_brim_ears(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    dispose() {
        wasm.projectsession_dispose(this.__wbg_ptr);
    }
    /**
     * A `FacetRegionRequest` over the session's acknowledged state; returns a
     * `FacetRegionReply`.
     * @param {string} request
     * @returns {string}
     */
    facet_region(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_facet_region(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {ProjectOpen} ticket
     * @param {ProjectDocument} document
     * @returns {ProjectEffects}
     */
    finish_open(ticket, document) {
        _assertClass(ticket, ProjectOpen);
        _assertClass(document, ProjectDocument);
        const ret = wasm.projectsession_finish_open(this.__wbg_ptr, ticket.__wbg_ptr, document.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectEffects.__wrap(ret[0]);
    }
    /**
     * @returns {CapturedHistory}
     */
    history() {
        const ret = wasm.projectsession_history(this.__wbg_ptr);
        return CapturedHistory.__wrap(ret);
    }
    /**
     * @returns {number}
     */
    history_revision() {
        const ret = wasm.projectsession_history_revision(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {ProjectGuard} guard
     * @returns {boolean}
     */
    is_current(guard) {
        _assertClass(guard, ProjectGuard);
        const ret = wasm.projectsession_is_current(this.__wbg_ptr, guard.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @returns {boolean}
     */
    is_disposed() {
        const ret = wasm.projectsession_is_disposed(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {ProjectGuard} guard
     * @returns {boolean}
     */
    is_export_current(guard) {
        _assertClass(guard, ProjectGuard);
        const ret = wasm.projectsession_is_export_current(this.__wbg_ptr, guard.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * @param {ProjectOpen} ticket
     * @returns {boolean}
     */
    is_open_current(ticket) {
        _assertClass(ticket, ProjectOpen);
        const ret = wasm.projectsession_is_open_current(this.__wbg_ptr, ticket.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * One volume's features captured for measuring: a
     * `MeasureVolumeRequest`. Its `reply` gives the counts or the refusal,
     * and `feature` resolves picks off this session.
     * @param {string} request
     * @returns {ProjectMeasureVolume}
     */
    measure_volume(request) {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_measure_volume(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectMeasureVolume.__wrap(ret[0]);
    }
    /**
     * The renderer packet for one of the session's mesh assets: a
     * `MeshPacketRequest`. Its `reply` gives the packet's shape or the
     * refusal, and `bytes` pages the chunk table and chunks.
     * @param {string} request
     * @returns {ProjectMeshPacket}
     */
    mesh_packet(request) {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_mesh_packet(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectMeshPacket.__wrap(ret[0]);
    }
    /**
     * The paint facets of one volume's channel: a `PaintOverlayRequest`.
     * The capture owns its runs, leaves and colours.
     * @param {string} request
     * @returns {ProjectPaintFacets}
     */
    paint_facets(request) {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_paint_facets(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectPaintFacets.__wrap(ret[0]);
    }
    /**
     * The canonical paint overlay of one volume's channel: a
     * `PaintOverlayRequest`. The capture owns its facets and packets.
     * @param {string} request
     * @returns {ProjectPaintOverlay}
     */
    paint_overlay(request) {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_paint_overlay(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectPaintOverlay.__wrap(ret[0]);
    }
    /**
     * Open a paint stroke on the state `guard` captured: a `PaintStrokeOpen`.
     * The stroke owns its mesh, so its samples never touch this session.
     * @param {ProjectGuard} guard
     * @param {string} request
     * @returns {ProjectPaintStroke}
     */
    paint_stroke(guard, request) {
        _assertClass(guard, ProjectGuard);
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_paint_stroke(this.__wbg_ptr, guard.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectPaintStroke.__wrap(ret[0]);
    }
    /**
     * @returns {number}
     */
    pending_count() {
        const ret = wasm.projectsession_pending_count(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * One plate's volumes captured for picking: a `PickSceneRequest`. The
     * scene owns its meshes, so picks run off the session.
     * @param {string} request
     * @returns {ProjectPickScene}
     */
    pick_scene(request) {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_pick_scene(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectPickScene.__wrap(ret[0]);
    }
    /**
     * One plate's arrangement: an `ArrangeRequest`; returns an `ArrangeReply`.
     * @param {string} request
     * @returns {string}
     */
    plan_arrangement(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_plan_arrangement(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Copies of one instance in a plate's free space: a `BedFillRequest`;
     * returns a `BedFillReply`.
     * @param {string} request
     * @returns {string}
     */
    plan_bed_fill(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_plan_bed_fill(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A helper volume for the object a selection names:
     * `{"ids","primary","role","sizeMm"}` → `{"assetJson","idsUsed",
     * "objectId","volumeJson"}` or `{"refusal"}`.
     * @param {string} request
     * @returns {string}
     */
    plan_helper_volume(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_plan_helper_volume(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The transforms one placement edit submits: a `PlacementRequest`;
     * returns a `PlacementReply`.
     * @param {string} request
     * @returns {string}
     */
    plan_placement(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_plan_placement(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * A primitive as a new object of the acknowledged state
     * (`orcaxr_project::primitives`): `{"bedMm","ids","importedAt","kind",
     * "plateId","sizeMm"}` → `{"assetJson","idsUsed","objectJson","plateId",
     * "reusedAsset"}` or `{"refusal"}`.
     * @param {string} request
     * @returns {string}
     */
    plan_primitive_object(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_plan_primitive_object(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The plate's wipe tower, auto-placed: a `WipeTowerRequest`; returns a
     * `WipeTowerReply`.
     * @param {string} request
     * @returns {string}
     */
    plan_wipe_tower(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_plan_wipe_tower(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {number} id
     * @returns {boolean}
     */
    release_staged(id) {
        const ret = wasm.projectsession_release_staged(this.__wbg_ptr, id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * A `RenderRequest`: a page of the renderer deltas from the snapshot the
     * host shows to the session's acknowledged one; returns a `RenderPage`.
     * @param {string} request
     * @returns {string}
     */
    render(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_render(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {ProjectGuard} guard
     * @param {ProjectDocument} document
     * @returns {ProjectEffects}
     */
    reset_document(guard, document) {
        _assertClass(guard, ProjectGuard);
        _assertClass(document, ProjectDocument);
        const ret = wasm.projectsession_reset_document(this.__wbg_ptr, guard.__wbg_ptr, document.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectEffects.__wrap(ret[0]);
    }
    /**
     * @returns {ProjectReply | undefined}
     */
    run_next() {
        const ret = wasm.projectsession_run_next(this.__wbg_ptr);
        return ret === 0 ? undefined : ProjectReply.__wrap(ret);
    }
    /**
     * @param {ProjectGuard} guard
     * @param {ProjectSelectionInput} input
     * @param {number} primary
     * @returns {ProjectEffects}
     */
    select(guard, input, primary) {
        _assertClass(guard, ProjectGuard);
        _assertClass(input, ProjectSelectionInput);
        var ptr0 = input.__destroy_into_raw();
        const ret = wasm.projectsession_select(this.__wbg_ptr, guard.__wbg_ptr, ptr0, primary);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectEffects.__wrap(ret[0]);
    }
    /**
     * @returns {CapturedSelection}
     */
    selection() {
        const ret = wasm.projectsession_selection(this.__wbg_ptr);
        return CapturedSelection.__wrap(ret);
    }
    /**
     * @returns {CapturedProject}
     */
    snapshot() {
        const ret = wasm.projectsession_snapshot(this.__wbg_ptr);
        return CapturedProject.__wrap(ret);
    }
    /**
     * @param {ProjectCommandUpload} input
     * @returns {number}
     */
    stage_commands(input) {
        _assertClass(input, ProjectCommandUpload);
        var ptr0 = input.__destroy_into_raw();
        const ret = wasm.projectsession_stage_commands(this.__wbg_ptr, ptr0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Stage a prepared emboss cut (an `EmbossStage`) for `executeStaged`: a
     * new text part under the host's IDs, or a re-cut of a text part.
     * @param {ProjectEmboss} emboss
     * @param {string} request
     * @returns {number}
     */
    stage_emboss(emboss, request) {
        _assertClass(emboss, ProjectEmboss);
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_stage_emboss(this.__wbg_ptr, emboss.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Stage the stroke's whole gesture as one edit for `executeStaged`; 0
     * when it touched no facet. A stroke whose state changed refuses `stale`.
     * @param {ProjectPaintStroke} stroke
     * @param {Uint16Array | null} [label]
     * @returns {number}
     */
    stage_paint_stroke(stroke, label) {
        _assertClass(stroke, ProjectPaintStroke);
        var ptr0 = isLikeNone(label) ? 0 : passArray16ToWasm0(label, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_stage_paint_stroke(this.__wbg_ptr, stroke.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Stage the slicing configuration a live catalog choice describes
     * (`{"autoPairs","live"}`) as one "Update slicing configuration"
     * replacement for `executeStaged`; `words` are the random words new pair
     * identities draw. Answers `{"staged": id}`, `{"unchanged": true}` or
     * `{"error","message"}`; a disposed session or one without staging room
     * throws its code.
     * @param {ProfileCatalog} catalog
     * @param {string} request
     * @param {Float64Array} words
     * @returns {string}
     */
    stage_slicing_configuration(catalog, request, words) {
        let deferred4_0;
        let deferred4_1;
        try {
            _assertClass(catalog, ProfileCatalog);
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF64ToWasm0(words, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_stage_slicing_configuration(this.__wbg_ptr, catalog.__wbg_ptr, ptr0, len0, ptr1, len1);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * Stage a prepared SVG cut (an `SvgPartStage`) for `executeStaged`: a
     * new part under the host's IDs, or a re-cut of an SVG part.
     * @param {ProjectSvgPart} svg
     * @param {string} request
     * @returns {number}
     */
    stage_svg_part(svg, request) {
        _assertClass(svg, ProjectSvgPart);
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_stage_svg_part(this.__wbg_ptr, svg.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Stage a prepared decimation under the host's asset ID (a
     * `VolumeSimplifyStage`) for `executeStaged`. A run whose state changed
     * refuses `stale`.
     * @param {ProjectVolumeSimplify} simplify
     * @param {string} request
     * @returns {number}
     */
    stage_volume_simplify(simplify, request) {
        _assertClass(simplify, ProjectVolumeSimplify);
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_stage_volume_simplify(this.__wbg_ptr, simplify.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Stage a prepared split under the host's names (a `VolumeSplitStage`)
     * for `executeStaged`. A split whose state changed refuses `stale`.
     * @param {ProjectVolumeSplit} split
     * @param {string} request
     * @returns {number}
     */
    stage_volume_split(split, request) {
        _assertClass(split, ProjectVolumeSplit);
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_stage_volume_split(this.__wbg_ptr, split.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @returns {Float64Array}
     */
    staging_usage() {
        const ret = wasm.projectsession_staging_usage(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
    }
    /**
     * One object's placed ears that reach nothing: a
     * `BrimEarStrandedRequest`; returns a `BrimEarStrandedReply`.
     * @param {string} request
     * @returns {string}
     */
    stranded_brim_ears(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.projectsession_stranded_brim_ears(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {string} request
     * @returns {ProjectReply | undefined}
     */
    submit(request) {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_submit(this.__wbg_ptr, ptr0, len0);
        return ret === 0 ? undefined : ProjectReply.__wrap(ret);
    }
    /**
     * Decimate one volume's mesh on the state `guard` captured: a
     * `VolumeSimplifyRequest`. Its `reply` gives the summary, unchanged or
     * the refusal, and `mesh` pages the result's bytes.
     * @param {ProjectGuard} guard
     * @param {string} request
     * @returns {ProjectVolumeSimplify}
     */
    volume_simplify(guard, request) {
        _assertClass(guard, ProjectGuard);
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_volume_simplify(this.__wbg_ptr, guard.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectVolumeSimplify.__wrap(ret[0]);
    }
    /**
     * Prepare one volume's split on the state `guard` captured: a
     * `VolumeSplitRequest`. Its `reply` gives the parts or the refusal.
     * @param {ProjectGuard} guard
     * @param {string} request
     * @returns {ProjectVolumeSplit}
     */
    volume_split(guard, request) {
        _assertClass(guard, ProjectGuard);
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_volume_split(this.__wbg_ptr, guard.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectVolumeSplit.__wrap(ret[0]);
    }
    /**
     * Write the current immutable capture as a complete 3MF package. The guard
     * is captured with the same snapshot; writing never changes dirty state.
     * @param {number} version
     * @param {Float64Array} policy
     * @returns {ProjectArchiveOutput}
     */
    write_archive(version, policy) {
        const ptr0 = passArrayF64ToWasm0(policy, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectsession_write_archive(this.__wbg_ptr, version, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectArchiveOutput.__wrap(ret[0]);
    }
}
if (Symbol.dispose) ProjectSession.prototype[Symbol.dispose] = ProjectSession.prototype.free;

/**
 * One SVG cut, prepared from a drawing's file bytes and a recipe.
 */
export class ProjectSvgPart {
    static __wrap(ptr) {
        const obj = Object.create(ProjectSvgPart.prototype);
        obj.__wbg_ptr = ptr;
        ProjectSvgPartFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectSvgPartFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectsvgpart_free(ptr, 0);
    }
    /**
     * Bytes `start..start + count` of the cut's indexed-mesh payload.
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    mesh(start, count) {
        const ret = wasm.projectsvgpart_mesh(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The `SvgPartReply`: the cut's summary, or the refusal.
     * @returns {string}
     */
    reply() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectsvgpart_reply(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectSvgPart.prototype[Symbol.dispose] = ProjectSvgPart.prototype.free;

export class ProjectUpload {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectUploadFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectupload_free(ptr, 0);
    }
    /**
     * @param {number} offset
     * @param {Uint8Array} bytes
     */
    append_asset(offset, bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectupload_append_asset(this.__wbg_ptr, offset, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} offset
     * @param {Uint8Array} bytes
     */
    append_document(offset, bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectupload_append_document(this.__wbg_ptr, offset, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {number}
     */
    asset_count() {
        const ret = wasm.projectupload_asset_count(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {number} position
     * @returns {number}
     */
    begin_asset(position) {
        const ret = wasm.projectupload_begin_asset(this.__wbg_ptr, position);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    cancel_asset() {
        const ret = wasm.projectupload_cancel_asset(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    finish_asset() {
        const ret = wasm.projectupload_finish_asset(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} version
     * @param {number} document_bytes
     * @param {Float64Array} options
     */
    constructor(version, document_bytes, options) {
        const ptr0 = passArrayF64ToWasm0(options, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectupload_new(version, document_bytes, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        ProjectUploadFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Takes ownership even on failure. The nonce is fresh host entropy, not
     * domain-ID entropy. No initial state is published until the bundle is full.
     * @param {Float64Array} generation
     * @returns {ProjectSession}
     */
    open(generation) {
        const ptr = this.__destroy_into_raw();
        const ptr0 = passArrayF64ToWasm0(generation, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.projectupload_open(ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectSession.__wrap(ret[0]);
    }
    /**
     * Consumes the upload and verifies a complete immutable replacement bundle.
     * Preparation belongs to an owned import task; it publishes no live state.
     * @returns {ProjectDocument}
     */
    prepare() {
        const ptr = this.__destroy_into_raw();
        const ret = wasm.projectupload_prepare(ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ProjectDocument.__wrap(ret[0]);
    }
    /**
     * Consumes staged document input, including on admission failure. This
     * synchronous finalization belongs to the host's owned opening task.
     */
    seal_document() {
        const ret = wasm.projectupload_seal_document(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) ProjectUpload.prototype[Symbol.dispose] = ProjectUpload.prototype.free;

/**
 * One volume's decimation, prepared on a session guard.
 */
export class ProjectVolumeSimplify {
    static __wrap(ptr) {
        const obj = Object.create(ProjectVolumeSimplify.prototype);
        obj.__wbg_ptr = ptr;
        ProjectVolumeSimplifyFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectVolumeSimplifyFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectvolumesimplify_free(ptr, 0);
    }
    /**
     * Bytes `start..start + count` of the result's indexed-mesh payload.
     * @param {number} start
     * @param {number} count
     * @returns {Uint8Array}
     */
    mesh(start, count) {
        const ret = wasm.projectvolumesimplify_mesh(this.__wbg_ptr, start, count);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * The `VolumeSimplifyReply`: the summary, unchanged, or the refusal.
     * @returns {string}
     */
    reply() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectvolumesimplify_reply(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectVolumeSimplify.prototype[Symbol.dispose] = ProjectVolumeSimplify.prototype.free;

/**
 * One volume's split, prepared on a session guard.
 */
export class ProjectVolumeSplit {
    static __wrap(ptr) {
        const obj = Object.create(ProjectVolumeSplit.prototype);
        obj.__wbg_ptr = ptr;
        ProjectVolumeSplitFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ProjectVolumeSplitFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_projectvolumesplit_free(ptr, 0);
    }
    /**
     * The `VolumeSplitReply`: the parts and geometries, or the refusal.
     * @returns {string}
     */
    reply() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.projectvolumesplit_reply(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
}
if (Symbol.dispose) ProjectVolumeSplit.prototype[Symbol.dispose] = ProjectVolumeSplit.prototype.free;

/**
 * A settings draft over inherited values and one node's overrides.
 */
export class SettingsEditor {
    static __wrap(ptr) {
        const obj = Object.create(SettingsEditor.prototype);
        obj.__wbg_ptr = ptr;
        SettingsEditorFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SettingsEditorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_settingseditor_free(ptr, 0);
    }
    /**
     * Commit every draft; returns an `EditorCommitResult`.
     * @returns {string}
     */
    commit() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.settingseditor_commit(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * An `EditorFieldRef`; returns its `EditorComparison`.
     * @param {string} field
     * @returns {string}
     */
    compare(field) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(field, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.settingseditor_compare(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * An `EditorEdit`; returns its `EditorEditResult`.
     * @param {string} edit
     * @returns {string}
     */
    edit(edit) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(edit, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.settingseditor_edit(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * The latest query's field at `position`, as an `EditorField`.
     * @param {number} position
     * @returns {string}
     */
    field(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.settingseditor_field(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * For an editor opened on a project node: the project `Intent` that
     * applies its latest commit, guarded by the captured snapshot.
     * @returns {string}
     */
    intent() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.settingseditor_intent(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * An `EditorCreate`. Without a collator or folder the exact ASCII
     * policies apply and refuse other text.
     * @param {string} create
     * @param {any | null} [collator]
     * @param {any | null} [folder]
     */
    constructor(create, collator, folder) {
        const ptr0 = passStringToWasm0(create, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.settingseditor_new(ptr0, len0, isLikeNone(collator) ? 0 : addToExternrefTable0(collator), isLikeNone(folder) ? 0 : addToExternrefTable0(folder));
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        SettingsEditorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * This node's overrides as canonical JSON.
     * @returns {string}
     */
    overrides() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.settingseditor_overrides(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * Apply: the drafts' one commit, which becomes [`Self::intent`].
     * @returns {string}
     */
    panel_apply() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.settingseditor_panel_apply(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Cancel: every draft dropped.
     */
    panel_cancel() {
        wasm.settingseditor_panel_cancel(this.__wbg_ptr);
    }
    /**
     * A draft set, inherited or reset to the default; returns its outcome.
     * @param {string} request
     * @returns {string}
     */
    panel_edit(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.settingseditor_panel_edit(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * One field's row for `{"fieldId"}`, or the editor's refusal.
     * @param {string} request
     * @returns {string}
     */
    panel_row(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.settingseditor_panel_row(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Whether Apply has something valid to apply.
     * @returns {string}
     */
    panel_state() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.settingseditor_panel_state(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * The generated settings panel (`settingsPanelExchange.ts`): what it
     * shows for `{"mode","search"}`.
     * @param {string} request
     * @returns {string}
     */
    panel_view(request) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.settingseditor_panel_view(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * An `EditorQuery`; returns the number of fields.
     * @param {string} query
     * @returns {number}
     */
    query(query) {
        const ptr0 = passStringToWasm0(query, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.settingseditor_query(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @returns {number}
     */
    revision() {
        const ret = wasm.settingseditor_revision(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} position
     * @returns {string}
     */
    row(position) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.settingseditor_row(this.__wbg_ptr, position);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * An `EditorRowsRequest`; returns the number of rows.
     * @param {string} rows
     * @returns {number}
     */
    rows(rows) {
        const ptr0 = passStringToWasm0(rows, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.settingseditor_rows(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * An `EditorFieldRef`; returns its `EditorFieldState`.
     * @param {string} field
     * @returns {string}
     */
    state(field) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(field, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.settingseditor_state(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Fields the latest rows left out because no surface supports them.
     * @returns {number}
     */
    unavailable() {
        const ret = wasm.settingseditor_unavailable(this.__wbg_ptr);
        return ret >>> 0;
    }
}
if (Symbol.dispose) SettingsEditor.prototype[Symbol.dispose] = SettingsEditor.prototype.free;

/**
 * Which tools an artifact selects and the filament it declares, from its
 * bytes in order; `finish` answers the `GcodeToolUsage` and ends the scan.
 */
export class ToolUsageScanner {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        ToolUsageScannerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_toolusagescanner_free(ptr, 0);
    }
    /**
     * @param {Uint8Array} bytes
     */
    append(bytes) {
        const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.toolusagescanner_append(this.__wbg_ptr, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @returns {string}
     */
    finish() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.toolusagescanner_finish(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    constructor() {
        const ret = wasm.toolusagescanner_new();
        this.__wbg_ptr = ret;
        ToolUsageScannerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) ToolUsageScanner.prototype[Symbol.dispose] = ToolUsageScanner.prototype.free;

/**
 * A context menu's sections or the model toolbar's runs (`actionGroupsExchange`):
 * `{"actions":[id],"layout"}` in, `{"groups":[{"actions","group","label"}]}` out.
 * @param {string} request
 * @returns {string}
 */
export function action_groups(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.action_groups(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The instance transform one pinned alignment produces: an
 * `AssemblyAlignmentRequest`; returns an `AssemblyAlignmentReply`.
 * @param {string} request
 * @returns {string}
 */
export function assembly_alignment(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.assembly_alignment(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Which pinned assembly alignments two picked features allow: an
 * `AssemblyPair`; returns an `AssemblyAvailabilityReply`.
 * @param {string} request
 * @returns {string}
 */
export function assembly_availability(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.assembly_availability(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * View-only exploded offsets: an `ExplosionRequest`; returns an
 * `ExplosionReply`.
 * @param {string} request
 * @returns {string}
 */
export function assembly_explosion(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.assembly_explosion(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `CameraDescribeRequest`; the `PrinterText` describing the service.
 * @param {string} request
 * @returns {string}
 */
export function camera_describe(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.camera_describe(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `CameraFrameRequest`; the `OptionalPrinterReplyText` frame URL.
 * @param {string} request
 * @returns {string}
 */
export function camera_frame_url(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.camera_frame_url(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `CameraListFinish`; the `CameraListResult` a listing that ended without
 * a reply to read reads as.
 * @param {string} request
 * @returns {string}
 */
export function camera_list_finish(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.camera_list_finish(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The `PrinterSend` that lists a printer's cameras.
 * @returns {string}
 */
export function camera_list_plan() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.camera_list_plan();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * A `CameraListRequest` and its `/server/webcams/list` reply (Moonraker's
 * `result`, as JSON); the `CameraListResult`.
 * @param {string} request
 * @param {string} reply
 * @returns {string}
 */
export function camera_list_read(request, reply) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(reply, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.camera_list_read(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * A `CameraMechanismsRequest`; the `CameraMechanisms` worth trying, in order.
 * @param {string} request
 * @returns {string}
 */
export function camera_mechanisms(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.camera_mechanisms(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterCamera`; the milliseconds between its frames.
 * @param {string} camera
 * @returns {number}
 */
export function camera_poll_interval(camera) {
    const ptr0 = passStringToWasm0(camera, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.camera_poll_interval(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * A `CameraSnapshotFinish`; the `CameraFailure` a failed fetch reads as.
 * @param {string} request
 * @returns {string}
 */
export function camera_snapshot_failure(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.camera_snapshot_failure(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `CameraSnapshotRequest`; the `CameraSnapshotPlan`: how one frame is fetched.
 * @param {string} request
 * @returns {string}
 */
export function camera_snapshot_plan(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.camera_snapshot_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * `coerceOverrideValue`: a `LibraryCoerceRequest` to a `LibraryCoercedValue`.
 * @param {string} request
 * @returns {string}
 */
export function coerce_override_value(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.coerce_override_value(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The command palette's search (`commandPaletteExchange`):
 * `{"actions":[{"hint"?,"id","label"}],"query"}` in, `{"matches":[index]}` out.
 * @param {string} request
 * @returns {string}
 */
export function command_palette(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.command_palette(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `GcodeAssessRequest`; the `GcodeAssessment`: what sending the script at
 * this machine, right now, would do.
 * @param {string} request
 * @returns {string}
 */
export function console_assess(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.console_assess(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `ConsoleFinish`; the `ConsoleResult` an exchange that ended without a
 * reply to read reads as.
 * @param {string} request
 * @returns {string}
 */
export function console_finish(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.console_finish(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MacroInvocationRequest`; the `MacroInvocation`: the script, or why it
 * cannot be spelled.
 * @param {string} request
 * @returns {string}
 */
export function console_invocation(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.console_invocation(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `ConsoleLineRequest`; the `ConsoleLine` the transcript keeps.
 * @param {string} request
 * @returns {string}
 */
export function console_line(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.console_line(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `ConsoleNotificationRequest` and the notification's params (as JSON);
 * the `OptionalConsoleLine` it adds.
 * @param {string} request
 * @param {string} params
 * @returns {string}
 */
export function console_notification(request, params) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(params, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.console_notification(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * A `ConsoleOperation`; the `ConsolePlan`: the request it sends, or why it
 * is refused before anything leaves.
 * @param {string} operation
 * @returns {string}
 */
export function console_plan(operation) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.console_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `ConsoleOperation` and its reply (Moonraker's `result`, as JSON); the
 * `ConsoleResult`.
 * @param {string} operation
 * @param {string} reply
 * @returns {string}
 */
export function console_read(operation, reply) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(reply, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.console_read(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * A `ConsoleRecentRequest`; the `TextList` of recent commands.
 * @param {string} request
 * @returns {string}
 */
export function console_recent(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.console_recent(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @returns {string}
 */
export function core_info() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.core_info();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}

/**
 * The stored credentials text (none: nothing stored); the
 * `RememberedCredentials` it reads as.
 * @param {string | null} [stored]
 * @returns {string}
 */
export function credentials_load(stored) {
    let deferred3_0;
    let deferred3_1;
    try {
        var ptr0 = isLikeNone(stored) ? 0 : passStringToWasm0(stored, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.credentials_load(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `RememberedCredentials`; the text to store, or none to remove what is
 * stored.
 * @param {string} record
 * @returns {string | undefined}
 */
export function credentials_save(record) {
    const ptr0 = passStringToWasm0(record, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.credentials_save(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    let v2;
    if (ret[0] !== 0) {
        v2 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v2;
}

/**
 * A `TransportFailure`; how it reads, as `PrinterText`.
 * @param {string} request
 * @returns {string}
 */
export function describe_transport_failure(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.describe_transport_failure(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * @param {string} request
 * @returns {string}
 */
export function evaluate(request) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.evaluate(ptr0, len0);
        deferred2_0 = ret[0];
        deferred2_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * An `ExternalSlicerArtifactRead` (the facts its host streamed); the
 * `ExternalSlicerArtifact`: accepted, with the job to release, or refused.
 * @param {string} read
 * @returns {string}
 */
export function external_slicer_artifact(read) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(read, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_artifact(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerReply` to the attestation; the `ExternalSlicerAttestation`
 * it reads as against the pinned build.
 * @param {string} reply
 * @returns {string}
 */
export function external_slicer_attestation(reply) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(reply, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_attestation(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerEndpointRequest`; the `ExternalSlicerAttestationPlan`:
 * the engine attestation it sends, or how it reads when none can be sent.
 * @param {string} request
 * @returns {string}
 */
export function external_slicer_attestation_plan(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_attestation_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerCancelRead`; the `ExternalSlicerCancelStep`.
 * @param {string} read
 * @returns {string}
 */
export function external_slicer_cancel(read) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(read, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_cancel(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerDownloadRead` (the attempt, and its transport's
 * failure or its artifact's verdict); the `ExternalSlicerDownloadStep`:
 * accept, fetch the retained result again, or fail.
 * @param {string} read
 * @returns {string}
 */
export function external_slicer_download(read) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(read, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_download(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerEndpointRequest`; the `ExternalSlicerEndpoint`: the
 * canonical endpoint a captured address names, or why none can be made.
 * @param {string} request
 * @returns {string}
 */
export function external_slicer_endpoint(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_endpoint(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerJobRequest`; the `ExternalSlicerPlan` one step of a job sends.
 * @param {string} request
 * @returns {string}
 */
export function external_slicer_job_plan(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_job_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerPollRead`; the `ExternalSlicerPollStep`.
 * @param {string} read
 * @returns {string}
 */
export function external_slicer_poll(read) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(read, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_poll(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The external route's metadata (`sliceRouteExchange`):
 * `{"endpoint","engine":{"artifactHash","commit"}}` in,
 * `{"engine","id","kind","protocolVersion"}` or `{"error"}` out.
 * @param {string} request
 * @returns {string}
 */
export function external_slicer_route(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_route(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerSubmitRead`; the `ExternalSlicerSubmission`: a job to
 * poll or cancel, an artifact to read, or a failure.
 * @param {string} read
 * @returns {string}
 */
export function external_slicer_submission(read) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(read, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_submission(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An `ExternalSlicerEndpointRequest`; the `ExternalSlicerPlan` submitting a
 * project sends (the archive and overrides are the host's multipart fields).
 * @param {string} request
 * @returns {string}
 */
export function external_slicer_submit_plan(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.external_slicer_submit_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Whether the attested engine (`wasm` or `cli`) carries `feature`.
 * @param {string} engine
 * @param {string} feature
 * @returns {boolean}
 */
export function external_slicer_supports(engine, feature) {
    const ptr0 = passStringToWasm0(engine, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passStringToWasm0(feature, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.external_slicer_supports(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0] !== 0;
}

/**
 * A Snapmaker filament query reply as received; the `FilamentSlotsReply`.
 * @param {string} text
 * @returns {string}
 */
export function filament_slots(text) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.filament_slots(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * `formatOverrideValue`: a `LibraryFormatRequest` to a `LibraryFormattedValue`.
 * @param {string} request
 * @returns {string}
 */
export function format_override_value(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.format_override_value(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * `/printer/gcode/help` reply text; the command names, or unknown.
 * @param {string} text
 * @returns {string}
 */
export function gcode_commands(text) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gcode_commands(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `GuardedPrinterActionsRequest`; the `GuardedPrinterActions` to offer.
 * @param {string} request
 * @returns {string}
 */
export function guarded_printer_actions(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.guarded_printer_actions(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Typed height-range bounds (`layerRangeBoundsExchange`).
 * @param {string} request
 * @returns {string}
 */
export function layer_range_bounds(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.layer_range_bounds(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * What a height-range operation says (`layerRangeMessagesExchange`).
 * @param {string} request
 * @returns {string}
 */
export function layer_range_messages(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.layer_range_messages(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A typed split height (`layerRangeSplitExchange`).
 * @param {string} request
 * @returns {string}
 */
export function layer_range_split(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.layer_range_split(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The workspace's measurement of two features: a `MeasureRequest`; returns
 * a `MeasureReply`.
 * @param {string} request
 * @returns {string}
 */
export function measure_features(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.measure_features(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MoonrakerCredentialCheck`; the `MoonrakerCredentialReply`.
 * @param {string} request
 * @returns {string}
 */
export function moonraker_credentials(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonraker_credentials(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MoonrakerEndpointRequest`; the `MoonrakerEndpointReply`.
 * @param {string} request
 * @returns {string}
 */
export function moonraker_endpoint(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonraker_endpoint(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MoonrakerErrorResponse`; the `MoonrakerTransportFault` it is reported as.
 * @param {string} request
 * @returns {string}
 */
export function moonraker_error_response(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonraker_error_response(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MoonrakerHandshakeRequest`; the `MoonrakerHandshakeReply`.
 * @param {string} request
 * @returns {string}
 */
export function moonraker_handshake(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonraker_handshake(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MoonrakerMethodCheck`; the `MoonrakerCheckReply`.
 * @param {string} request
 * @returns {string}
 */
export function moonraker_method_check(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonraker_method_check(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MoonrakerPathRequest`; the `MoonrakerPathReply`.
 * @param {string} request
 * @returns {string}
 */
export function moonraker_path(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonraker_path(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MoonrakerReconnectDelayRequest`; the delay in milliseconds.
 * @param {string} request
 * @returns {number}
 */
export function moonraker_reconnect_delay(request) {
    const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.moonraker_reconnect_delay(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ret[0];
}

/**
 * A `MoonrakerReconnectPolicyInput`; the `MoonrakerReconnectPolicyReply`.
 * @param {string} request
 * @returns {string}
 */
export function moonraker_reconnect_policy(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonraker_reconnect_policy(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `MoonrakerObjectSubscription`; the `MoonrakerSubscriptionReply`.
 * @param {string} request
 * @returns {string}
 */
export function moonraker_subscription(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.moonraker_subscription(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The colours a filament library paints states in (`paintFacetColorsExchange`):
 * `{"channel","filaments","states"}` in, `{"colors"}` out.
 * @param {string} request
 * @returns {string}
 */
export function paint_facet_colors(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.paint_facet_colors(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The paint stroke sample a pointer hit makes with the painter's settings
 * (`paintToolSampleExchange`): `{"channel","hit","settings","stateOrder"}`
 * in, `{"sample"}` or `{"error","message"}` out.
 * @param {string} request
 * @returns {string}
 */
export function paint_tool_sample(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.paint_tool_sample(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The print configuration a plate of a state document overrides
 * (`platePrintOverrides`), as a canonical JSON object of engine wire strings.
 * @param {string} state
 * @param {string} plate_id
 * @returns {string}
 */
export function plate_print_overrides(state, plate_id) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(state, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(plate_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.plate_print_overrides(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * One plate of a state document projected for an external slicer
 * (`projectPlateArchiveForSlice`), admitted under the host's `Date.parse`:
 * `plate_id` is a JSON string, `omitted` a JSON array of the source asset
 * IDs whose payloads the host does not hold. Answers canonical JSON —
 * `{"assetIds","sourceHash","stateJson"}`, or `{"error","message"}` with the
 * browser's message. A session's project is projected through
 * `ProjectExport.plate` instead.
 * @param {string} state
 * @param {string} plate_id
 * @param {string} omitted
 * @returns {string}
 */
export function plate_projection(state, plate_id, omitted) {
    let deferred5_0;
    let deferred5_1;
    try {
        const ptr0 = passStringToWasm0(state, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(plate_id, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(omitted, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.plate_projection(ptr0, len0, ptr1, len1, ptr2, len2);
        var ptr4 = ret[0];
        var len4 = ret[1];
        if (ret[3]) {
            ptr4 = 0; len4 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred5_0 = ptr4;
        deferred5_1 = len4;
        return getStringFromWasm0(ptr4, len4);
    } finally {
        wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
    }
}

/**
 * Cut a recipe with the host's glyph outlines: an `EmbossRequest`.
 * @param {string} request
 * @returns {ProjectEmboss}
 */
export function prepare_emboss(request) {
    const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.prepare_emboss(ptr0, len0);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProjectEmboss.__wrap(ret[0]);
}

/**
 * Cut a drawing's file bytes with a recipe: an `SvgPartRequest`.
 * @param {string} request
 * @param {Uint8Array} drawing
 * @returns {ProjectSvgPart}
 */
export function prepare_svg_part(request, drawing) {
    const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ptr1 = passArray8ToWasm0(drawing, wasm.__wbindgen_malloc);
    const len1 = WASM_VECTOR_LEN;
    const ret = wasm.prepare_svg_part(ptr0, len0, ptr1, len1);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return ProjectSvgPart.__wrap(ret[0]);
}

/**
 * A primitive's or the helper cube's canonical mesh payload
 * (`orcaxr_project::primitives::payload_json`): `{"kind","sizeMm"}` in, the
 * bytes the browser stores out.
 * @param {string} request
 * @returns {Uint8Array}
 */
export function primitive_payload(request) {
    const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.primitive_payload(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * A metadata reply's text and the `PrinterText` filename asked about; the
 * `PrintFileIdentityReply`.
 * @param {string} text
 * @param {string} filename
 * @returns {string}
 */
export function print_file_identity(text, filename) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(filename, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.print_file_identity(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * A duration in seconds; the `OptionalText` an operator reads it as.
 * @param {number} seconds
 * @returns {string}
 */
export function print_history_duration(seconds) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.print_history_duration(seconds);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * A filament length in millimetres; the `OptionalText` an operator reads it as.
 * @param {number} millimetres
 * @returns {string}
 */
export function print_history_filament(millimetres) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.print_history_filament(millimetres);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * A `PrintHistoryFinish`; the `PrintHistoryResult` an exchange that ended
 * without a reply to read reads as.
 * @param {string} request
 * @returns {string}
 */
export function print_history_finish(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_history_finish(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintHistoryJob` (on the bulk tier); its `PrintHistoryJobView`.
 * @param {string} job
 * @returns {string}
 */
export function print_history_job_view(job) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(job, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_history_job_view(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintHistoryPageShape`; the `PrintHistoryPageView` a pager shows.
 * @param {string} shape
 * @returns {string}
 */
export function print_history_page_view(shape) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(shape, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_history_page_view(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintHistoryOperation`; the `PrintHistoryPlan`: the request it sends,
 * or why it is refused before anything leaves.
 * @param {string} operation
 * @returns {string}
 */
export function print_history_plan(operation) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_history_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintHistoryOperation` and its reply (Moonraker's `result`, as JSON);
 * the `PrintHistoryResult`.
 * @param {string} operation
 * @param {string} reply
 * @returns {string}
 */
export function print_history_read(operation, reply) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(reply, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.print_history_read(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * An `OptionalPrintHistoryTotals`; the `PrinterText` a panel shows.
 * @param {string} totals
 * @returns {string}
 */
export function print_history_totals_text(totals) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(totals, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_history_totals_text(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintJobAvailabilityRequest`; the `PrintJobCommandDescriptors` the
 * observed state allows.
 * @param {string} request
 * @returns {string}
 */
export function print_job_availability(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_job_availability(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintJobCommandFailureRequest`; the `PrintJobCommandRefusal` it reports.
 * @param {string} request
 * @returns {string}
 */
export function print_job_command_failure(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_job_command_failure(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintJobCommandCheckRequest`; the `PrintJobCommandPlan`.
 * @param {string} request
 * @returns {string}
 */
export function print_job_command_plan(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_job_command_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintPreparationPlanRequest`; the `PrintPreparationPlan`.
 * @param {string} request
 * @returns {string}
 */
export function print_preparation_plan(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_preparation_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintPreparationStep`; the `PrinterSend` it posts.
 * @param {string} request
 * @returns {string}
 */
export function print_preparation_send(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_preparation_send(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The readiness query's reply text; the `PrintReadiness`.
 * @param {string} text
 * @returns {string}
 */
export function print_readiness(text) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_readiness(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrintReadinessFailure`; the `PrintReadiness` of a failed query.
 * @param {string} request
 * @returns {string}
 */
export function print_readiness_failure(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_readiness_failure(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterCapabilityReport`; the `PrintStartOptions` it supports.
 * @param {string} request
 * @returns {string}
 */
export function print_start_options(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.print_start_options(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterDirectoryAdd`; the `PrinterDirectoryReply`.
 * @param {string} request
 * @returns {string}
 */
export function printer_directory_add(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_directory_add(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterDirectoryAdopt`; the `PrinterDirectory` with a legacy endpoint adopted.
 * @param {string} request
 * @returns {string}
 */
export function printer_directory_adopt(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_directory_adopt(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The stored directory text (none: nothing stored); the `PrinterDirectory`
 * it reads as.
 * @param {string | null} [stored]
 * @returns {string}
 */
export function printer_directory_load(stored) {
    let deferred3_0;
    let deferred3_1;
    try {
        var ptr0 = isLikeNone(stored) ? 0 : passStringToWasm0(stored, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_directory_load(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterDirectorySelect`; the `PrinterDirectoryReply` of removing it.
 * @param {string} request
 * @returns {string}
 */
export function printer_directory_remove(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_directory_remove(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterDirectory`; the text it is stored as.
 * @param {string} directory_json
 * @returns {string}
 */
export function printer_directory_save(directory_json) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(directory_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_directory_save(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterDirectorySelect`; the `PrinterDirectoryReply` of making it the default.
 * @param {string} request
 * @returns {string}
 */
export function printer_directory_set_default(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_directory_set_default(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterDirectoryUpdate`; the `PrinterDirectoryReply`.
 * @param {string} request
 * @returns {string}
 */
export function printer_directory_update(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_directory_update(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * `/printer/objects/list` reply text; the objects, or unknown.
 * @param {string} text
 * @returns {string}
 */
export function printer_objects(text) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_objects(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterStatusRequest`; the `PrinterStatusSummary` compact surfaces show.
 * @param {string} request
 * @returns {string}
 */
export function printer_status_summary(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_status_summary(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterStorageFinish`; the `PrinterStorageResult` an exchange that
 * ended without a reply to read reads as.
 * @param {string} request
 * @returns {string}
 */
export function printer_storage_finish(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_storage_finish(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterStorageOperation`; the `PrinterStoragePlan`: the request or
 * download it sends, or why it is refused before anything leaves.
 * @param {string} operation
 * @returns {string}
 */
export function printer_storage_plan(operation) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.printer_storage_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A `PrinterStorageOperation` and its listing or metadata reply (Moonraker's
 * `result`, as JSON); the `PrinterStorageResult`.
 * @param {string} operation
 * @param {string} reply
 * @returns {string}
 */
export function printer_storage_read(operation, reply) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(operation, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(reply, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.printer_storage_read(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * A size in bytes; the `OptionalText` an operator reads it as.
 * @param {number} bytes
 * @returns {string}
 */
export function printer_storage_size(bytes) {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.printer_storage_size(bytes);
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * A `PrinterText` filename; the sanitized upload name.
 * @param {string} request
 * @returns {string}
 */
export function sanitize_gcode_filename(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.sanitize_gcode_filename(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * `/server/info` reply text; the components, or unknown.
 * @param {string} text
 * @returns {string}
 */
export function server_components(text) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(text, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.server_components(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The Full Spectrum rules: an `EditorRuleRequest` to `EditorRules`.
 * @param {string} rules
 * @returns {string}
 */
export function settings_rules(rules) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(rules, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.settings_rules(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * `stepSettingValue`: an `EditorStepRequest` to an `EditorStep`.
 * @param {string} step
 * @returns {string}
 */
export function settings_step(step) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(step, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.settings_step(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The scoped settings panel's words for a target
 * (`settingsTargetTextExchange`): `{"label","overrideCount","path","scope"}`
 * in, `{"heading","summary","text"}` out.
 * @param {string} request
 * @returns {string}
 */
export function settings_target_text(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.settings_target_text(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * An output binding checked (`sliceBindingExchange`): `{"binding"}` in,
 * `{"valid":true}` or `{"error"}` out.
 * @param {string} request
 * @returns {string}
 */
export function slice_binding(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_binding(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * This device's route (`orcaxr_project::slicing::sidecar::Route::android_native`):
 * `{"engine":{"artifactHash","commit"}}` in, the route's metadata or
 * `{"error"}` out.
 * @param {string} request
 * @returns {string}
 */
export function slice_native_route(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_native_route(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The plates a slice slices (`slicePlanExchange`): `{"scope","stateJson"}`
 * in, `{"plateIds"}` or `{"refusal"}` out.
 * @param {string} request
 * @returns {string}
 */
export function slice_plan(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_plan(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The profile snapshot a plate is sliced with (`sliceProfilesExchange`):
 * `{"plateId","stateJson"}` in, `{"effectiveConfigHash","references"}` or
 * `{"error"}` out.
 * @param {string} request
 * @returns {string}
 */
export function slice_profiles(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_profiles(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The sidecar published beside a plate's G-code:
 * `{"binding","gcodeBytes","profiles","route","summary","warnings"}` in, the
 * `orcaxr.slice-output` document or `{"error"}` out.
 * @param {string} request
 * @returns {string}
 */
export function slice_sidecar(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_sidecar(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * One thumbnail in the engine's wire format (`thumbnailBlockExchange`):
 * `{"image","request"}` in, the block's text as a JSON string out.
 * @param {string} request
 * @returns {string}
 */
export function slice_thumbnail_block(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_thumbnail_block(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A G-code with its thumbnail blocks (`thumbnailInjectExchange`):
 * `{"blocks","gcode"}` in, the G-code as a JSON string out.
 * @param {string} request
 * @returns {string}
 */
export function slice_thumbnail_inject(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_thumbnail_inject(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * What a printer's `thumbnails` value asks for (`thumbnailListExchange`):
 * `{"value"?}` in, `{"problems","requests"}` out.
 * @param {string} request
 * @returns {string}
 */
export function slice_thumbnail_list(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_thumbnail_list(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The thumbnail camera (`thumbnailViewExchange`): `{"aspect","max","min"}`
 * in, `{"fovDeg","position","target"}` out.
 * @param {string} request
 * @returns {string}
 */
export function slice_thumbnail_view(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slice_thumbnail_view(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The one option a typed name means among `options` (`presetMatchExchange`):
 * `{"options","query"}` in, `{"option": option | null}` out.
 * @param {string} request
 * @returns {string}
 */
export function slicing_match(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.slicing_match(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The state a slicing configuration leads to (`nextSlicingStateExchange`):
 * `{"autoPairs","configurationJson","stateJson"}` and the random words new
 * pair identities draw (sixteen each) in; `{"stateJson"}`,
 * `{"unchanged":true}` or `{"error","message"}` out, admitted under the
 * host's `Date.parse`.
 * @param {string} request
 * @param {Float64Array} words
 * @returns {string}
 */
export function slicing_next_state(request, words) {
    let deferred4_0;
    let deferred4_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF64ToWasm0(words, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.slicing_next_state(ptr0, len0, ptr1, len1);
        var ptr3 = ret[0];
        var len3 = ret[1];
        if (ret[3]) {
            ptr3 = 0; len3 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred4_0 = ptr3;
        deferred4_1 = len3;
        return getStringFromWasm0(ptr3, len3);
    } finally {
        wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
    }
}

/**
 * A `ToolMappingRequest`; the `ToolMappingReport`.
 * @param {string} request
 * @returns {string}
 */
export function tool_mapping(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.tool_mapping(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * What an edit of the three fields submits (`transformFieldEditExchange`):
 * `{"origins","primaryInstanceId","texts","tool"}` in, `{"changes"}` or
 * `{"error":"invalid_edit","message"}` out.
 * @param {string} request
 * @returns {string}
 */
export function transform_field_edit(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transform_field_edit(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * What a tool's three fields show (`transformFieldsExchange`):
 * `{"tool","transform"}` in, `{"texts","values"}` out.
 * @param {string} request
 * @returns {string}
 */
export function transform_fields(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transform_fields(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The transform gizmo attached to a proxy pose (`orcaxr_project::placement::gizmo`):
 * `{"proxy"}` in, the gizmo's state out.
 * @param {string} request
 * @returns {string}
 */
export function transform_gizmo_attach(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transform_gizmo_attach(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * What a gizmo drag submits (`transformGizmoChangesExchange`):
 * `{"initialProxy","mode","origins","proxy"}` in, `{"changes"}` or
 * `{"error":"invalid_drag","message"}` out.
 * @param {string} request
 * @returns {string}
 */
export function transform_gizmo_changes(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transform_gizmo_changes(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * Every gizmo handle's baked geometry and the drag plane's
 * (`transformGizmoGeometryExchange`).
 * @returns {string}
 */
export function transform_gizmo_geometry() {
    let deferred2_0;
    let deferred2_1;
    try {
        const ret = wasm.transform_gizmo_geometry();
        var ptr1 = ret[0];
        var len1 = ret[1];
        if (ret[3]) {
            ptr1 = 0; len1 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred2_0 = ptr1;
        deferred2_1 = len1;
        return getStringFromWasm0(ptr1, len1);
    } finally {
        wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
    }
}

/**
 * What the gizmo shows: `{"camera","mode","root","space","state"}` in,
 * `{"axis","dragging","handles","proxy"}` out.
 * @param {string} request
 * @returns {string}
 */
export function transform_gizmo_present(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transform_gizmo_present(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * One pointer event (`transformGizmoExchange`'s steps):
 * `{"camera","event","mode","root","space","state"}` in, the next state out.
 * @param {string} request
 * @returns {string}
 */
export function transform_gizmo_step(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transform_gizmo_step(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * three's Euler ↔ quaternion conversion (`transformRotationExchange`):
 * `{"rotation"}` → `{"eulerRadians"}`, or `{"eulerRadians"}` → `{"rotation"}`.
 * @param {string} request
 * @returns {string}
 */
export function transform_rotation(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.transform_rotation(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * What the dialog shows for its fields (`virtualFilamentFormExchange`):
 * `{"library","form","search"}` in, `{"issues","preview",...}` out.
 * @param {string} request
 * @returns {string}
 */
export function virtual_filament_form(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.virtual_filament_form(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The fields an author dialog opens with (`virtualFilamentFormDefaultsExchange`):
 * `{"library","operation","filamentId"}` in, the form out.
 * @param {string} request
 * @returns {string}
 */
export function virtual_filament_form_defaults(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.virtual_filament_form_defaults(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The pinned Match search's candidates (`virtualFilamentMatchSearchExchange`):
 * `{"library","targetColor","minComponentPercent"}` in, `{"candidates"}` out.
 * @param {string} request
 * @returns {string}
 */
export function virtual_filament_match_search(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.virtual_filament_match_search(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * The proportions the triangle picker writes (`virtualFilamentTriangleExchange`):
 * `{"x","y"}` in, `{"weights"}` or `{"error"}` out.
 * @param {string} request
 * @returns {string}
 */
export function virtual_filament_triangle(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.virtual_filament_triangle(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}

/**
 * A project configuration's bed and a plate tower's keep-out
 * (`workspaceBedExchange`): `{"config","wipeTower"}` in,
 * `{"keepOut","printableArea","printableHeightMm","sizeMm"}` out.
 * @param {string} request
 * @returns {string}
 */
export function workspace_bed(request) {
    let deferred3_0;
    let deferred3_1;
    try {
        const ptr0 = passStringToWasm0(request, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.workspace_bed(ptr0, len0);
        var ptr2 = ret[0];
        var len2 = ret[1];
        if (ret[3]) {
            ptr2 = 0; len2 = 0;
            throw takeFromExternrefTable0(ret[2]);
        }
        deferred3_0 = ptr2;
        deferred3_1 = len2;
        return getStringFromWasm0(ptr2, len2);
    } finally {
        wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_compare_30d8e60a815f47b5: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = arg0.compare(getArrayU16FromWasm0(arg1, arg2), getArrayU16FromWasm0(arg3, arg4));
            return ret;
        }, arguments); },
        __wbg_concat_31b84501191b3bea: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.concat(arg1);
            return ret;
        }, arguments); },
        __wbg_fold_dfceac45bd85ab6b: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg1.fold(getArrayU16FromWasm0(arg2, arg3));
            const ptr1 = passArray16ToWasm0(ret, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        }, arguments); },
        __wbg_fromCharCode_d356c26e26e2d234: function() { return handleError(function (arg0, arg1) {
            const ret = String.fromCharCode(...(getArrayU16FromWasm0(arg0, arg1)));
            return ret;
        }, arguments); },
        __wbg_parse_c9742817a51d2d60: function() { return handleError(function (arg0) {
            const ret = Date.parse(arg0);
            return ret;
        }, arguments); },
        __wbindgen_generic_0000000000000001: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./orcaxr_core_bg.js": import0,
    };
}

const CapturedHistoryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_capturedhistory_free(ptr, 1));
const CapturedProjectFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_capturedproject_free(ptr, 1));
const CapturedSelectionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_capturedselection_free(ptr, 1));
const HoldToConfirmFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_holdtoconfirm_free(ptr, 1));
const MoonrakerTransportFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_moonrakertransport_free(ptr, 1));
const PresetLibraryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_presetlibrary_free(ptr, 1));
const PrintJobStatusFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_printjobstatus_free(ptr, 1));
const PrintWorkflowFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_printworkflow_free(ptr, 1));
const PrinterSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_printersession_free(ptr, 1));
const ProfileCatalogFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_profilecatalog_free(ptr, 1));
const ProfileCatalogUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_profilecatalogupload_free(ptr, 1));
const ProjectArchiveImportFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectarchiveimport_free(ptr, 1));
const ProjectArchiveOutputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectarchiveoutput_free(ptr, 1));
const ProjectArchiveUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectarchiveupload_free(ptr, 1));
const ProjectAssetFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectasset_free(ptr, 1));
const ProjectBytesFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectbytes_free(ptr, 1));
const ProjectClipboardFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectclipboard_free(ptr, 1));
const ProjectCommandUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectcommandupload_free(ptr, 1));
const ProjectDocumentFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectdocument_free(ptr, 1));
const ProjectEffectsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projecteffects_free(ptr, 1));
const ProjectEmbossFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectemboss_free(ptr, 1));
const ProjectExportFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectexport_free(ptr, 1));
const ProjectGuardFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectguard_free(ptr, 1));
const ProjectImportBaseFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectimportbase_free(ptr, 1));
const ProjectImportPreviewFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectimportpreview_free(ptr, 1));
const ProjectMeasureVolumeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectmeasurevolume_free(ptr, 1));
const ProjectMeshPacketFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectmeshpacket_free(ptr, 1));
const ProjectModelUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectmodelupload_free(ptr, 1));
const ProjectOpenFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectopen_free(ptr, 1));
const ProjectPaintFacetsFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectpaintfacets_free(ptr, 1));
const ProjectPaintOverlayFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectpaintoverlay_free(ptr, 1));
const ProjectPaintStrokeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectpaintstroke_free(ptr, 1));
const ProjectPickSceneFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectpickscene_free(ptr, 1));
const ProjectPreflightFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectpreflight_free(ptr, 1));
const ProjectQueryListFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectquerylist_free(ptr, 1));
const ProjectQueryNodeFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectquerynode_free(ptr, 1));
const ProjectReplyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectreply_free(ptr, 1));
const ProjectSelectionInputFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectselectioninput_free(ptr, 1));
const ProjectSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectsession_free(ptr, 1));
const ProjectSvgPartFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectsvgpart_free(ptr, 1));
const ProjectUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectupload_free(ptr, 1));
const ProjectVolumeSimplifyFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectvolumesimplify_free(ptr, 1));
const ProjectVolumeSplitFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectvolumesplit_free(ptr, 1));
const SettingsEditorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_settingseditor_free(ptr, 1));
const ToolUsageScannerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_toolusagescanner_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function _assertClass(instance, klass) {
    if (!(instance instanceof klass)) {
        throw new Error(`expected instance of ${klass.name}`);
    }
}

function getArrayF64FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat64ArrayMemory0().subarray(ptr / 8, ptr / 8 + len);
}

function getArrayU16FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint16ArrayMemory0().subarray(ptr / 2, ptr / 2 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat64ArrayMemory0 = null;
function getFloat64ArrayMemory0() {
    if (cachedFloat64ArrayMemory0 === null || cachedFloat64ArrayMemory0.byteLength === 0) {
        cachedFloat64ArrayMemory0 = new Float64Array(wasm.memory.buffer);
    }
    return cachedFloat64ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint16ArrayMemory0 = null;
function getUint16ArrayMemory0() {
    if (cachedUint16ArrayMemory0 === null || cachedUint16ArrayMemory0.byteLength === 0) {
        cachedUint16ArrayMemory0 = new Uint16Array(wasm.memory.buffer);
    }
    return cachedUint16ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray16ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 2, 2) >>> 0;
    getUint16ArrayMemory0().set(arg, ptr / 2);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF64ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 8, 8) >>> 0;
    getFloat64ArrayMemory0().set(arg, ptr / 8);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayJsValueToWasm0(array, malloc) {
    const ptr = malloc(array.length * 4, 4) >>> 0;
    for (let i = 0; i < array.length; i++) {
        const add = addToExternrefTable0(array[i]);
        getDataViewMemory0().setUint32(ptr + 4 * i, add, true);
    }
    WASM_VECTOR_LEN = array.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat64ArrayMemory0 = null;
    cachedUint16ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('orcaxr_core_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
