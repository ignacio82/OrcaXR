# P6.1 engine-option schema v2 foundation

This directory generates the source-backed settings contract consumed by
`web/src/settings/generated/loader.ts`. It reads Git objects at the exact
Snapmaker OrcaSlicer v2.3.4 parity pin; it never reads the dirty submodule
worktree.

The generated schema currently contains 816 definitions and 809 unique runtime
keys. That is the 789 parity-manifest registration templates with three dynamic
axis prefixes expanded to 12 canonical XYZE keys, plus 18 dynamically generated
nullable `filament_*` keys. All source-provided defaults and metadata expressions
are resolved, while retaining their C++ expressions and commit/blob provenance.
Unknown fields, registration forms, value expressions, enum maps, serialization
authority, missing manifest keys, type drift, and source-blob drift fail closed.

Schema v2 also reads the exact pinned `src/slic3r/GUI/Tab.cpp` Git blob and
cross-checks the parity manifest's 21 tabs, 93 groups, and 424 literal
`append_single_option_line` placements (417 unique keys) call-by-call, including
source line, symbol, anchor, and blob. It emits stable tab/group relationships
and source order. Of those placements, 420 bind one generated definition and
four retain all duplicate-owner definition IDs with an `ambiguous` disposition.
The loader pins these inventory counts and validates every relationship rather
than accepting self-consistent truncation.

Run:

```sh
node tools/settings-schema/generate.mjs --check --no-fetch
node tools/settings-schema/self-test.mjs
(cd web && node --import tsx src/settings/generated/loader.test.ts)
```

Regenerate after an intentional pin or extractor change with:

```sh
node tools/settings-schema/generate.mjs --no-fetch
```

Do not hand-edit `engine-options.schema.json`.

## Exact boundary of this foundation

P6.1 remains partial. The schema captures key, owner, option/storage type,
scalar/vector/nullability and wire delimiters, explicit default, min/max and
max-literal bounds, unit, enum maps/values/labels (including U1 and extended
variants), mode, technology, category, labels, tooltip, multiline/full-width,
read-only, dimensions, GUI hints, CLI metadata, ratio-over and explicit aliases.
It now captures the manifest-backed literal UI tab/page/group hierarchy and
ordering from `Tab.cpp`. The generated coverage records 395 definitions without
a literal placement, 26 dynamic-key placement calls, and four exact custom-widget
calls. Three exact `set_project_bool` calls are retained as narrow project-config
write evidence for the reviewed FullSpectrum dependency behavior.

The layout remains deliberately partial: dynamic and composite/multi-option line
builders are not promoted to literal placements; custom-widget behavior and
general object/part/layer/plate scope eligibility remain unresolved and fail
closed. Dependency/visibility predicates and per-control reset/inheritance rules
are explicitly `unresolved-unenforced`, not misrepresented as blocked. The
project override panel therefore enables exact Process-surface placements plus
the narrow, source-pinned FullSpectrum project override overlay (including the
three exact project-config writes); Filament, Printer, Object, and Plate-only
fields remain visible but unavailable until they have scope-specific canonical
mutation seams.

A compiled, commit-pinned `ConfigOptionDef` dumper is still needed to certify the
source parser against effective runtime defaults and maps. Legacy conversions in
`handle_legacy` are intentionally not promoted to aliases. The extracted labels
are the source English localization keys, not runtime locale translations.

There are 91 definitions with no explicit `set_default_value`; all are runtime or
read-only state families rather than `PrintConfigDef` settings. Their exact IDs
are recorded in `coverage.definitionsWithoutExplicitDefault`, and consumers must
not invent defaults. Seven keys are intentionally ambiguous across owners:
`chamber_temperature`, `downward_check`, `outer_wall_acceleration`,
`preset_names`, `retract_lift_above`, `retract_lift_below`, and `scale`. Runtime
lookup therefore requires an owner whenever a key has multiple definitions.
