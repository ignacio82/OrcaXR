# OrcaXR WebApp Parity Plan

> **Instructions for AI Agents:**
> - When working on a feature, review its corresponding Android implementation files (listed below each item) to understand the underlying logic, math, and data structures.
> - Ensure UI elements are built using the `xrblocks` UIKit components in `web/src/workspace/OrcaWorkspace.ts` (or creating new panel files as needed).
> - **Mark tasks as complete** by changing `- [ ]` to `- [x]` when a feature has been fully ported to the WebApp.
> - Keep notes on WebApp-specific architectural decisions beneath each item as you implement them.

This document outlines all features and UI elements present in the OrcaXR Android application (for Galaxy XR) that are currently missing in the XRBlocks-based WebApp.

---

## 1. Core Slicing & Pre-Flight Checks
The Android app features a robust set of safety and compatibility checks that appear as dynamic banners, which are missing in the web version.

- [ ] **Bed Collision & Overflow Banner**
  - **Feature**: Real-time vertex-walked collision detection that shows exactly how many triangles are off-bed, reports the worst overflow axes (X/Y mm), and gates the slicing process.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/BedCollision.kt`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt` (`LeftProjectPanel`)

- [ ] **Filament Rules & Compatibility Banner**
  - **Feature**: Pre-flight checks warning the user about bed-to-filament compatibility (e.g., PLA on a specific bed type).
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/FilamentRules.kt`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt` (`FilamentRulesBanner`)

- [ ] **Top Cover Hint Banner**
  - **Feature**: Recommends keeping the printer's top cover open or closed depending on the selected filament profile (e.g., PA-CF vs PLA).
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/TopCoverRule.kt`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt` (`TopCoverHintBanner`)

- [ ] **Bambu Studio 3MF Import Banner**
  - **Feature**: Detects imported Bambu Studio 3MFs, warns about dropped unsupported keys, and offers an action to automatically apply suggested native filament profiles.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/bambu/BambuImportTranslator.kt`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt` (`BambuImportBanner`)

- [ ] **Wipe Tower Auto-Position Toggle**
  - **Feature**: A switch in the UI that dynamically computes the wipe tower X/Y placement based on the bounding boxes of the plated models, overriding the static profile defaults.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/WipeTowerPlacement.kt`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt` (`WipeTowerAutoPositionRow`)

---

## 2. Model Manipulation & Tools
The WebApp currently has a basic modal tool system and limited boolean ops. The Android version supports much more complex model handling.

- [ ] **Multi-Model Placed Models List**
  - **Feature**: A comprehensive UI row system featuring collapsible/expandable groups for multipart models, quick actions (Repair, Emboss, Magnets, Delete), multi-select toggles, "Auto-arrange", and "Add Another" to append models.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/PlacedModel.kt`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt` (`PlacedModelsSection`)

- [ ] **Multi-Plate Support (Virtual Build Plates)**
  - **Feature**: Ability to assign models to different virtual plates (e.g., Plate 1, Plate 2) and move models between them via a dropdown menu.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/PlateStore.kt`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt`

- [ ] **Emboss & Engrave Tool**
  - **Feature**: Add and recess 3D text or SVGs/shapes directly onto model surfaces.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/EmbossOp.kt`, `app/src/main/java/dev/orcaxr/app/EmbossAssets.kt`

- [ ] **Add Magnets Tool**
  - **Feature**: Allows users to recess magnet pockets into the mesh and automatically injects a print-pause G-code at the correct Z-height for insertion.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/MagnetOp.kt`

- [ ] **Add Primitives**
  - **Feature**: Built-in ability to spawn basic meshes (Cube, Cylinder, Sphere) without uploading files.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/Primitives.kt`, `app/src/main/java/dev/orcaxr/app/AddPrimitivePanel.kt`

- [ ] **Simplify Model (Decimation)**
  - **Feature**: A dedicated panel to reduce mesh polygon count.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/SimplifyPanel.kt`

- [ ] **Adaptive / Variable Layer Height**
  - **Feature**: Tools to adjust layer height dynamically across the Z-axis of an object for better quality on curves.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/AdaptiveLayerPanel.kt`

---

## 3. Advanced Painting & AI Features
The WebApp only has a basic spherical paint brush. The Android app has a deeply integrated suite of painting tools.

- [ ] **AI & Semantic Painting**
  - **Feature**: AI-driven tools that intelligently paint regions based on object semantics or image prompts.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/AiPaintEngine.kt`, `app/src/main/java/dev/orcaxr/app/SemanticPaintPlanner.kt`, `app/src/main/java/dev/orcaxr/app/AiRenderEngine.kt`

- [ ] **Procedural & Mask Projection**
  - **Feature**: Apply decals, procedural masks, or project textures onto the mesh.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/AiMaskProjection.kt`, `app/src/main/java/dev/orcaxr/app/AiProceduralPaint.kt`, `app/src/main/java/dev/orcaxr/app/AiDecalEngine.kt`

- [ ] **Paint History (Undo/Redo)**
  - **Feature**: Historical states for all painting operations allowing users to step backward and forward.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/PaintHistory.kt`, `app/src/main/java/dev/orcaxr/app/PaintCacheStore.kt`

- [ ] **Smart Paint Dialogs & Templates**
  - **Feature**: Save, load, and resolve predefined paint templates.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/SmartPaintDialog.kt`, `app/src/main/java/dev/orcaxr/app/PaintTemplateResolver.kt`

---

## 4. Filament & Color Management
The WebApp currently has a naive color palette. The Android app cleanly separates aesthetic color from physical loadout.

- [ ] **Advanced Color Mapping Panel**
  - **Feature**: Explicit mapping UI where the user declares "Project Filament N *prints from* Physical Slot X or Virtual Mix Y".
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/UiPanels.kt` (`ColorMappingPanel`)

- [ ] **Virtual (Mixed) Colors (FullSpectrum)**
  - **Feature**: Define virtual filaments via equations (e.g., T1 + T2 = V1). Includes an advanced editor for mixing ratio, bias, pointillisme cadence, and local-Z modes.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/MixedFilamentStore.kt`, `app/src/main/java/dev/orcaxr/app/FullSpectrumGamut.kt`

- [ ] **Gamut Matching**
  - **Feature**: "Match to my filaments" button that automatically maps authored model colors (from 3MFs) to the closest available physical or virtual spool.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/GamutMatcher.kt`, `app/src/main/java/dev/orcaxr/app/GamutMatchControls.kt`

- [ ] **Moonraker Printer Sync**
  - **Feature**: Directly syncs the printer's active loaded spools (colors and material types) into the UI, making the physical slots read-only representations of reality.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/MoonrakerClient.kt`, `app/src/main/java/dev/orcaxr/app/UiPanels.kt` (`PrinterFilamentsSection`)

---

## 5. Printing & Network Integration
The WebApp requires manually entering the printer IP. The Android app provides a richer network experience.

- [ ] **Subnet Printer Discovery**
  - **Feature**: Automatically scans the local network for Moonraker/Klipper instances and presents them in a dropdown picker.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/SubnetScanner.kt`, `app/src/main/java/dev/orcaxr/app/PrinterDiscovery.kt`

- [ ] **Integrated Webcam View**
  - **Feature**: A dedicated spatial panel to view the active print via the printer's webcam stream.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/WebcamSession.kt`

- [ ] **Advanced Print & Send Options**
  - **Feature**: `SendAndPrintOptionsPanel` with finer controls over print jobs (e.g., timelapse, bed leveling toggles).
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/SendAndPrintOptionsPanel.kt`, `app/src/main/java/dev/orcaxr/app/PrintSendFlow.kt`

---

## 6. Other Advanced Features

- [ ] **Custom G-Code Insertion**
  - **Feature**: UI to insert arbitrary G-code at specific layers or objects.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/CustomGcodePanel.kt`, `app/src/main/java/dev/orcaxr/app/CustomGcodeStore.kt`

- [ ] **Calibration Ramp Generator**
  - **Feature**: Built-in tool to generate calibration prints for tuning.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/CalibrationRampGenerator.kt`

- [ ] **Handy Model Catalog**
  - **Feature**: In-app browser/library for fetching and placing remote models (e.g., from Makerworld or Printables).
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/HandyModelCatalog.kt`

- [ ] **Voice Commands**
  - **Feature**: Hands-free control over the workspace via a dedicated voice panel mount.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/voice/`, `app/src/main/java/dev/orcaxr/app/VoiceCommandPanelMount.kt`

- [ ] **Background Slicing Service (Async Slicing)**
  - **Feature**: Slicing happens asynchronously, allowing for robust cancellation and tracking.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/SliceForegroundService.kt`, `app/src/main/java/dev/orcaxr/app/SliceCancelReceiver.kt`

- [ ] **Settings Backup**
  - **Feature**: Backup and restore of user profiles, presets, and customized app settings.
  - **Android Ref**: `app/src/main/java/dev/orcaxr/app/SettingsBackup.kt`, `app/src/main/java/dev/orcaxr/app/SettingsBackupRunner.kt`
