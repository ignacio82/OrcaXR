package dev.orcaxr.app.mcp

/**
 * Audit H10 (2026-05-07) — capability names matching the Tier-B
 * callback parameters of `BindWorkspaceModel`. Each enum value
 * corresponds to ONE optional `(...) -> Unit` (or family of related
 * `() -> Unit`) callbacks on `BindWorkspaceModel`. When the host
 * activity passes a non-null lambda for that callback, the
 * corresponding [TierBCapability] is added to the
 * [WorkspaceModel.wiredTierBCapabilities] set; tools then check that
 * set to decide whether to emit the matching [WorkspaceAction] or to
 * fail fast with isError.
 *
 * Why an enum (vs. a string constant): the compiler catches typos at
 * the requireCapability call sites and forces an exhaustive `when`
 * if a future tool routes the action through a switch.
 *
 * Adding a new Tier-B callback:
 *  1. Add the enum value here.
 *  2. Add the callback param to `BindWorkspaceModel`.
 *  3. Wire its non-null check in `BindWorkspaceModel`'s
 *     `wiredTierBCapabilities` builder block.
 *  4. The matching tool gates on `ws.requireCapability(...)`.
 */
enum class TierBCapability {
    /** [WorkspaceAction.SliceActivePlate] — runs the slice pipeline. */
    SliceActivePlate,
    /** [WorkspaceAction.AutoArrangePlate] — libnest2d auto-pack. */
    AutoArrangePlate,
    /** [WorkspaceAction.DropToBed] — has a Compose-state fallback,
     *  callback only used to also bump preview state. NOT enforced
     *  via requireCapability since the fallback path is correct. */
    DropToBed,
    /** [WorkspaceAction.SaveGcodeToDownloads]. */
    SaveGcodeToDownloads,
    /** [WorkspaceAction.SaveProject3mf]. */
    SaveProject3mf,
    /** [WorkspaceAction.SaveModelStl]. */
    SaveModelStl,
    /** [WorkspaceAction.LoadModelFromPath]. */
    LoadModelFromPath,
    /** [WorkspaceAction.RepairModel]. */
    RepairModel,
    /** [WorkspaceAction.SimplifyModel]. */
    SimplifyModel,
    /** [WorkspaceAction.ComputeAdaptiveLayerHeights]. */
    ComputeAdaptiveLayerHeights,
    /** [WorkspaceAction.AddCustomGcodeTick]. */
    AddCustomGcodeTick,
    /** [WorkspaceAction.RemoveCustomGcodeTick]. */
    RemoveCustomGcodeTick,
    /** [WorkspaceAction.ClearCustomGcodeTicks]. */
    ClearCustomGcodeTicks,
    /** [WorkspaceAction.CutModel]. */
    CutModel,
    /** [WorkspaceAction.MeshBoolean]. */
    MeshBoolean,
    /** [WorkspaceAction.SplitModel]. */
    SplitModel,
    /** [WorkspaceAction.EmbossModel]. */
    EmbossModel,
    /** [WorkspaceAction.AddTextOrSvgObject]. */
    AddTextOrSvgObject,
    /** [WorkspaceAction.AddTextOrSvgVolume]. */
    AddTextOrSvgVolume,
    /** [WorkspaceAction.AddVolumeToModel]. */
    AddVolumeToModel,
    /** [WorkspaceAction.RemoveVolume]. */
    RemoveVolume,
    /** [WorkspaceAction.ClearPaint]. */
    ClearPaint,
    /** [WorkspaceAction.ReplacePaintTag]. */
    ReplacePaintTag,
    /** [WorkspaceAction.PaintPlaneSplit]. */
    PaintPlaneSplit,
    /** [WorkspaceAction.PaintUndo]. */
    PaintUndo,
    /** [WorkspaceAction.PaintRedo]. */
    PaintRedo,
    /** [WorkspaceAction.PaintTriangleSet]. */
    PaintTriangleSet,
    /** [WorkspaceAction.LoadPaintState]. */
    LoadPaintState,
}
