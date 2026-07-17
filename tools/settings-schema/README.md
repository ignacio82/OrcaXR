# P6.1 engine-option schema foundation

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
It does not yet capture UI tab/page/group hierarchy or ordering, dependency and
visibility predicates, specialized widget behavior, reset/inheritance rules, or
allowed object/part/layer scopes; those contracts live outside `PrintConfig.cpp`
and require a separate pinned GUI-source extractor.

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

