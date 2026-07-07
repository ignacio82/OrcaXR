# OrcaXR Web MCP Implementation Plan

This document outlines the plan to implement the MCP (Model Context Protocol) tools from the Android app into the Web app (`OrcaXR/web`).

## Instructions for Implementation
1. **Implement iteratively:** Pick a category or a single tool and implement it in the `web` app using the `WebMCP` framework.
2. **Test before checking:** Before you mark any checkbox as complete (`- [x]`), you **MUST** test the tool locally to verify that it functions correctly within the web context. Do not mark an item as done if you haven't validated it.
3. **Check things off:** Once a tool is fully implemented and tested, update this file by replacing `- [ ]` with `- [x]`.

## Tool Categories

### Core Workspace & State Management
- [x] `WorkspaceTools`: Tools for manipulating models, plates, selection, and scene state.
- [ ] `ProfileTools`: Getting and setting printer/filament/process profiles.
- [ ] `FilamentTools`: Managing filament palette, adding/removing/updating colors.
- [x] `SystemTools`: General system status and version info.
- [ ] `PrefsTools`: App preference reads and writes.

### AI & Vision Integration
- [ ] `AiVisionTools`: General LLM vision processing and bounding box detection.
- [ ] `AiVisionMaskTools`: Segmenting and masking regions via vision AI.
- [ ] `AiIntrospectionTools`: Tools for AI to analyze its own previous operations or current scene geometry constraints.
- [ ] `AiAnchorTools`: Identifying semantic anchor points on models.
- [ ] `FindFeatureAnchorsTool`: Finding specific geometric or semantic features.
- [ ] `MultiProviderVisionClient`: Vision abstraction for different AI backends.

### Painting & Coloration
- [ ] `AiPaintTools`: Core AI-driven painting capabilities.
- [ ] `AiSemanticPaintTools`: Painting by semantic regions.
- [ ] `AiAdvancedPaintTools`: Advanced brush and masking controls.
- [ ] `PaintStrokeTool`: Executing primitive paint strokes on models.
- [ ] `PaintSessionTools`: Managing paint sessions (undo/redo, commit).
- [ ] `PaintConstraintTools`: Applying geometric constraints to paint strokes.
- [ ] `PaintDecalTool`: Applying decals to model surfaces.
- [ ] `RenderPaintSessionDiffTool`: Visualizing paint differences.
- [ ] `SymmetryTools`: Enforcing symmetry rules during painting.
- [ ] `FsPaintSupport`: FullSpectrum Paint support.

### Auto-Painting & Recipes
- [ ] `AutoPaintTool`: Core auto-paint execution.
- [ ] `AutoPaintReferenceTool`: Using reference images for auto-painting.
- [ ] `AutoPaintLabelTool`: Auto-painting based on text labels.
- [ ] `PaintTemplateTools`: Managing and applying paint templates.
- [ ] `PaintRecipeTools`: Handling multi-step paint recipes.
- [ ] `RecipeRecommendTools`: AI recommending paint recipes.
- [ ] `ScorePaintAgainstReferenceTool`: Evaluating paint accuracy against a reference.

### Printer & Slicer Management
- [ ] `PrinterTools`: Connection testing, sending G-code, observing print status.
- [ ] `CalibrationTools`: Managing printer calibration prints.
- [ ] `WipeTowerTools`: Managing wipe tower placement and settings.

### Utilities & Advanced Features
- [ ] `NativeBvhTools`: Tools interacting with BVH (Bounding Volume Hierarchy) for fast raycasting/geometry operations.
- [ ] `PrimitiveTools`: Spawning and manipulating basic 3D primitives.
- [ ] `MagnetTools`: Snap-to tools for models and modifiers.
- [ ] `HandyModelTools`: Accessing the handy models catalog.
- [ ] `RecentTools`: Recent files and projects history.
- [ ] `SettingsBackupTools`: Backing up and restoring user settings.

---

**Remember:** Update this document as you make progress and always verify functionality before checking off a task!
