#!/bin/bash
set -e

# OrcaXR Bundle Build Script
#
# Builds a signed Android App Bundle (.aab) for the Play Store.
# Requires signing credentials in local.properties.
#
# Note: Forcing arm64-v8a because libslic3r is currently only 
# pre-built for this ABI.

echo "Building OrcaXR Release Bundle (arm64-v8a)..."

./gradlew :app:bundleRelease \
  "$@"

echo ""
echo "Bundle generated at: app/build/outputs/bundle/release/app-release.aab"
