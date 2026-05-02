#!/usr/bin/env bash
# autotest_slice.sh — drive the dragon-slice round-trip without a human.
#
# Cold-starts OrcaXR, broadcasts LOAD_3MF then SLICE via the debug-only
# TestBroadcastReceiver (app/src/debug/), and tails logcat until one of:
#   - G-code success     -> exit 0  (writes /tmp/orcaxr_slice_outcome=GCODE)
#   - ASAN report        -> exit 10 (writes ASAN, dumps full report)
#   - SIGSEGV/tombstone  -> exit 11 (writes SEGV, dumps backtrace)
#   - load failed/timeout -> exit 12
#   - slice timeout      -> exit 13
#
# Designed to be invoked synchronously by an automated harness (eg an
# AI assistant in a /loop) so each iteration of [edit -> rebuild ->
# install -> test] ends with a single deterministic exit code +
# /tmp/orcaxr_slice_outcome.txt summary.
#
# Requires the debug APK installed (release builds excluded the receiver).
# See GEMINI.md gotcha #6 for why this stays debug-only.

set -uo pipefail

DEVICE="${DEVICE:-adb-R3GYB0AQXWE-nYV2BD._adb-tls-connect._tcp}"
# Default to the debug variant since release strips the receiver entirely.
# Override via env when testing a non-default applicationId variant.
PKG="${PKG:-dev.orcaxr.app.debug}"
# Activity FQN. Debug builds add ".debug" as an applicationIdSuffix only —
# the actual class still lives in the dev.orcaxr.app package, so
# "$PKG/.MainActivity" (relative) resolves to "dev.orcaxr.app.debug.MainActivity"
# which doesn't exist. Always use the absolute class name.
ACTIVITY="${ACTIVITY:-dev.orcaxr.app.MainActivity}"
# NOTE: paths with spaces get mangled by Android's `am` argument parser
# (it sees "Quick Share/..." as a ComponentName). Always use a no-space
# path on-device; `adb push` or `cp` from the spaced path before testing.
DRAGON="${DRAGON:-/storage/emulated/0/Download/dragon.3mf}"
LOAD_TIMEOUT="${LOAD_TIMEOUT:-60}"
SLICE_TIMEOUT="${SLICE_TIMEOUT:-1800}"
OUTCOME_FILE="${OUTCOME_FILE:-/tmp/orcaxr_slice_outcome.txt}"
LOG_FILE="${LOG_FILE:-/tmp/orcaxr_autotest.log}"

ADB="adb -s $DEVICE"

log() { printf '%s autotest: %s\n' "$(date +%H:%M:%S)" "$*" >&2; }

write_outcome() {
    # arg1 = short verdict (GCODE | ASAN | SEGV | LOAD_FAIL | TIMEOUT)
    # arg2... = detail body
    local verdict="$1"; shift
    {
        printf 'verdict=%s\n' "$verdict"
        printf 'time=%s\n' "$(date -Iseconds)"
        printf 'device=%s\n' "$DEVICE"
        printf 'dragon=%s\n' "$DRAGON"
        printf -- '----- detail -----\n'
        printf '%s\n' "$*"
    } > "$OUTCOME_FILE"
    log "verdict=$verdict written to $OUTCOME_FILE"
}

# 1. Make sure device is present
if ! $ADB get-state >/dev/null 2>&1; then
    log "device $DEVICE not found"
    write_outcome "NO_DEVICE" "adb get-state failed"
    exit 14
fi

# 2. Make sure MainActivity is foregrounded but DO NOT force-stop —
# that wipes in-memory state (active printer selection, slot palette)
# that's only restored after the user re-taps the printer panel.
# Restarting the activity with `am start` brings it back to foreground
# without killing the process if it's already running.
log "starting MainActivity (no force-stop)"
$ADB shell am start -n "$PKG/$ACTIVITY" >/dev/null

# 3. Wait for the activity to compose so the LaunchedEffect collector is
# subscribed to TestController.commands BEFORE we send broadcasts. The
# OrcaXR/jni `init: ...` line lands during JNI_OnLoad which fires when
# MainActivity touches SlicerEngine.
log "waiting for app process"
for i in $(seq 1 30); do
    if pid=$($ADB shell pidof "$PKG" 2>/dev/null) && [ -n "$pid" ]; then
        log "app pid=$pid"
        break
    fi
    sleep 0.5
done
# Extra grace so MainActivity composition completes (the
# LaunchedEffect(Unit) collector subscribes during initial composition).
sleep 3

# 4. Clear logcat so we only see this run's events
$ADB logcat -c

# 5. Broadcast LOAD_3MF and wait for the load to finish.
#
# Sending via `run-as $PKG` so the broadcast originates from the app's
# UID — the receiver's signature-level TRIGGER_TEST_RECEIVER permission
# (added in 4d4e49f to keep the wide-open control surface from being
# triggerable by any sideloaded app on the device) blocks bare
# `adb shell am broadcast`, which runs as shell uid 2000 and can't
# satisfy a signature perm. `--user 0` is required because run-as
# defaults to user -2 (UserHandle.USER_NULL) which AM rejects without
# INTERACT_ACROSS_USERS_FULL.
log "broadcasting LOAD_3MF $DRAGON"
$ADB shell run-as "$PKG" am broadcast --user 0 -p "$PKG" \
    -a dev.orcaxr.app.test.LOAD_3MF \
    --es path "$DRAGON" >/dev/null

# Load completes when nativeWriteColoredGlb writes the GLB. Bail on
# read failure / no triangles too.
log "waiting up to ${LOAD_TIMEOUT}s for load complete"
load_signal=$(timeout "$LOAD_TIMEOUT" $ADB logcat -s "OrcaXR/jni:*" 2>&1 \
    | grep --line-buffered -m 1 -E "nativeWriteColoredGlb: wrote|nativeWriteColoredGlb: read failed|nativeWriteColoredGlb: no triangles|nativeWriteColoredGlb: model has no objects" \
    || true)
if [ -z "$load_signal" ]; then
    write_outcome "LOAD_FAIL" "no load-complete log line within ${LOAD_TIMEOUT}s"
    exit 12
fi
if ! echo "$load_signal" | grep -q "nativeWriteColoredGlb: wrote"; then
    write_outcome "LOAD_FAIL" "$load_signal"
    exit 12
fi
log "load OK: $load_signal"

# 6. Broadcast SLICE (see #5 for why this routes through run-as).
log "broadcasting SLICE"
$ADB shell run-as "$PKG" am broadcast --user 0 -p "$PKG" \
    -a dev.orcaxr.app.test.SLICE >/dev/null

# 7. Tail logcat until outcome lands. We watch the WHOLE log buffer (not
# just OrcaXR/jni) so we catch SIGSEGV / FATAL / ASAN markers from libc
# and the linker too. Stream into LOG_FILE in case post-mortem reading
# is needed.
log "waiting up to ${SLICE_TIMEOUT}s for slice outcome"
> "$LOG_FILE"
outcome_line=$(timeout "$SLICE_TIMEOUT" $ADB logcat 2>&1 \
    | tee "$LOG_FILE" \
    | grep --line-buffered -m 1 -E "OrcaXR/jni: nativeSlice: G-code written|ERROR: AddressSanitizer|AddressSanitizer:|F libc.*Fatal signal 11|FATAL EXCEPTION|tombstoned: received crash request" \
    || true)

if [ -z "$outcome_line" ]; then
    write_outcome "TIMEOUT" "no outcome log line within ${SLICE_TIMEOUT}s"
    exit 13
fi

case "$outcome_line" in
    *"G-code written"*)
        # Pull the exact path
        gpath=$(echo "$outcome_line" | sed -n 's/.*G-code written to \([^ ]*\).*/\1/p')
        write_outcome "GCODE" "$outcome_line${gpath:+\\noutput=$gpath}"
        exit 0
        ;;
    *"AddressSanitizer"*)
        # Slurp ~200 lines of ASAN report from $LOG_FILE for the harness
        report=$(grep -A 200 "AddressSanitizer" "$LOG_FILE" | head -200)
        write_outcome "ASAN" "$report"
        exit 10
        ;;
    *"Fatal signal 11"*|*"tombstoned"*|*"FATAL EXCEPTION"*)
        # Try to capture the DEBUG backtrace that follows in logcat
        # within the next few seconds.
        sleep 3
        bt=$($ADB logcat -d -b crash 2>&1 | grep -A 80 "$(echo "$outcome_line" | awk '{print $7}' | head -1)" | head -100)
        write_outcome "SEGV" "$outcome_line\\n----- backtrace -----\\n$bt"
        exit 11
        ;;
    *)
        write_outcome "UNKNOWN" "$outcome_line"
        exit 99
        ;;
esac
