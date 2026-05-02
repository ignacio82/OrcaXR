---
colors:
  mint: "#79D0C7"
  mint-bright: "#94E2D6"
  mint-deep: "#4DB6AC"
  warn: "#FFB86B"
  red: "#F25C5C"
  bg-deep: "#000814"
  panel: "rgba(8, 16, 30, 0.80)"
  panel-strong: "rgba(6, 12, 24, 0.92)"
  panel-soft: "rgba(20, 30, 48, 0.55)"
  line: "rgba(180, 200, 230, 0.10)"
  line-strong: "rgba(180, 200, 230, 0.20)"
  text: "#EEF2F7"
  text-muted: "#93A3B8"
  text-dim: "#5C6A82"
  role-outer-wall: "#F25959"
  role-inner-wall: "#40BF73"
  role-infill: "#F2D959"
  role-support: "#666673"

typography:
  display-lg:
    fontFamily: Space Grotesk
    fontSize: 32sp
    fontWeight: "700"
  display-md:
    fontFamily: Space Grotesk
    fontSize: 26sp
    fontWeight: "700"
  display-sm:
    fontFamily: Space Grotesk
    fontSize: 22sp
    fontWeight: "600"
  title-lg:
    fontFamily: Space Grotesk
    fontSize: 18sp
    fontWeight: "600"
  title-md:
    fontFamily: Space Grotesk
    fontSize: 14sp
    fontWeight: "600"
    letterSpacing: 0.1sp
  body-lg:
    fontFamily: Instrument Sans
    fontSize: 15sp
    fontWeight: "400"
  body-md:
    fontFamily: Instrument Sans
    fontSize: 13sp
    fontWeight: "400"
  label-lg:
    fontFamily: Instrument Sans
    fontSize: 13sp
    fontWeight: "600"
    letterSpacing: 0.1sp
  numeric:
    fontFamily: JetBrains Mono
    fontSize: 12sp
    fontWeight: "600"
  kicker:
    fontFamily: Instrument Sans
    fontSize: 10sp
    fontWeight: "700"
    letterSpacing: 1.6sp

spacing:
  sm: 4dp
  md: 8dp
  lg: 12dp
  xl: 16dp
  xxl: 20dp

rounded:
  sm: 4dp
  md: 8dp
  lg: 12dp
  xl: 24dp

components:
  panel-base:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.xl}"
  panel-surface:
    backgroundColor: "{colors.panel-soft}"
    rounded: "{rounded.md}"
    padding: "{spacing.lg}"
  panel-chip:
    backgroundColor: "{colors.panel-strong}"
    rounded: "{rounded.md}"
    padding: "{spacing.md}"
---

# OrcaXR Design System

## Visual Identity: Deep-Sea Spatial UI
OrcaXR employs a dark, cool-toned aesthetic tailored for immersive spatial environments. The visual language relies heavily on semi-translucent, frosted-glass panels floating in front of a deep navy void. This dark background minimizes eye strain in Extended Reality (XR) while allowing vibrant 3D models, colorful toolpaths, and vivid interactive elements to command the user's attention.

## Typography
The system uses a purposeful, tri-font typographic scale to establish a clear visual hierarchy and technical precision:

- **Space Grotesk** is utilized for display headers, panel titles, and prominent call-to-action buttons. Its geometric, slightly tech-forward characteristics ground the UI in a modern, engineering-focused feel.
- **Instrument Sans** serves as the highly legible workhorse for body text, UI labels, and standard form controls. It remains readable even at smaller sizes or lower display resolutions in XR headsets.
- **JetBrains Mono** is employed strictly for tabular numerics and data (such as slice times, filament usage, geometric coordinates, or G-code lines). This ensures that numbers and technical readouts align perfectly in columns, which is critical for precision slicing.

## Color and Contrast
- **Mint** is the primary accent and interaction color. It provides stark, luminous contrast against the dark navy panels, clearly identifying active states, primary buttons, selected tabs, and interactive gizmos.
- **Text Hierarchy** is stratified into three layers of emphasis: a stark white-blue for primary readouts, a secondary cool gray for descriptions, and a recessed dim blue for section labels and hints.
- Thin, low-opacity **Line borders** are used to separate structural sections within panels or list items without adding heavy visual clutter.

## Slicer Extrusion Role Colors
The 3D toolpath visualization intentionally inherits its palette from standard desktop slicer conventions. This ensures immediate familiarity for existing makers transitioning to an XR workflow. For example:
- **Outer Walls:** Strong Red
- **Inner Walls:** Green
- **Infill:** Yellow / Sky Blue
- **Supports:** Dark Gray

## Spatial Depth and Ergonomics
- **Depth via Opacity:** Instead of utilizing traditional heavy drop shadows (which can conflict with stereoscopic depth in XR environments), depth hierarchy is established through varying panel opacities and hairline borders. The root panel background is the most transparent, while inner elevated nested surfaces and interactive pill-chips use more opaque alpha values to create physical layering.
- **Ergonomics:** UI elements, form fields, and touch targets are padded generously to accommodate the lack of sub-millimeter precision inherent in XR hand tracking and pinch gestures. Sharp corners are avoided, favoring large radii on parent panels to keep the aesthetic organic and approachable.