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
     * The checkpoint guard of the written capture, taken once. Acknowledge it
     * only after the host confirms the save handoff.
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
     * Consumes the upload on every outcome. `bed` is empty or `[width, depth]`
     * in millimetres. Production IDs come from a 32-byte random `id_seed`;
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
    dispose() {
        wasm.projectsession_dispose(this.__wbg_ptr);
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
     * @returns {number}
     */
    pending_count() {
        const ret = wasm.projectsession_pending_count(this.__wbg_ptr);
        return ret >>> 0;
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
     * @returns {Float64Array}
     */
    staging_usage() {
        const ret = wasm.projectsession_staging_usage(this.__wbg_ptr);
        var v1 = getArrayF64FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 8, 8);
        return v1;
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
        __wbg_concat_31b84501191b3bea: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.concat(arg1);
            return ret;
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
const ProjectModelUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectmodelupload_free(ptr, 1));
const ProjectOpenFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectopen_free(ptr, 1));
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
const ProjectUploadFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_projectupload_free(ptr, 1));

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
