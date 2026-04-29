# Patches against OrcaSlicer v2.3.2

Each `*.patch` file is applied (in filename sort order) to the
`third_party/OrcaSlicer/` submodule by `scripts/build_native.sh` before
every build. The script resets the submodule to the pinned tag first, so
patches apply against a known-clean tree.

**Naming:** `NNNN-short-slug.patch`, where `NNNN` zero-pads a serial. New
patches get the next number.

**Each patch must include a commit-message-style header** explaining
*why* the patch exists (what NDK / Android incompatibility it works
around, and what would need to be true upstream to retire it). Without
this, we lose track of what's ours vs. upstream over time.

**Before adding a patch**, consider: is this actually a libslic3r change,
or can the problem be solved by:
- adjusting CMake flags in `scripts/build_native.sh` (preferred)
- skipping an unused dep via the deps/CMakeLists.txt comment-out pattern
  (acceptable if small)
- choosing a different NDK/libc path

Patches are the *last* resort, because they create maintenance burden on
every upstream version bump.

**Retiring a patch:** when the underlying issue is fixed upstream (or we
bump to an OrcaSlicer version that doesn't need the workaround), delete
the file. Don't leave dead patches around.
