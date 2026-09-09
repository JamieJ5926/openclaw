#!/usr/bin/env bash
set -euo pipefail
test -x "$NODE_EXECUTABLE"
"$NODE_EXECUTABLE" --version
export ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT="$SDK_ROOT"
export ANDROID_AVD_HOME="$TRIAL/avd" ANDROID_USER_HOME="$TRIAL/android-user"
export PATH="$TRIAL/runtime/node_modules/.bin:$SDK_ROOT/platform-tools:$SDK_ROOT/emulator:$SDK_ROOT/cmdline-tools/latest/bin:/usr/bin:/bin"
mkdir "$ANDROID_AVD_HOME" "$ANDROID_USER_HOME"
test -r /dev/kvm
test -w /dev/kvm
/usr/bin/perl "$INPUT/kvm-access-probe.pl" > "$EVIDENCE/public/kvm-runtime.json"
emulator -accel-check
printf 'no\n' | avdmanager create avd --name catalog-result --package 'system-images;android-36;google_apis;x86_64' --device pixel_2 --path "$ANDROID_AVD_HOME/catalog-result.avd"
cat "$ANDROID_AVD_HOME/catalog-result.avd/config.ini" > "$EVIDENCE/public/avd-config.ini"
emulator_pid= fixture_pid=
cleanup() {
  local original_status=$? diagnostic_status=0
  trap - EXIT
  set +e
  if test -n "$emulator_pid"; then
    "$NODE_EXECUTABLE" "$INPUT/diagnose-native.mjs" after-app
    diagnostic_status=$?
  fi
  if test -n "$emulator_pid"; then
    timeout 10 adb -s emulator-5554 emu kill
    kill "$emulator_pid" 2>/dev/null
    wait "$emulator_pid"
  fi
  if test -n "$fixture_pid"; then kill "$fixture_pid" 2>/dev/null; wait "$fixture_pid"; fi
  adb kill-server
  if test "$original_status" -ne 0; then exit "$original_status"; fi
  exit "$diagnostic_status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
emulator -avd catalog-result -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -memory 2048 -cores 2 -port 5554 > "$EVIDENCE/public/emulator.log" 2>&1 &
emulator_pid=$!
bun "$INPUT/wire-fixture.mjs" > "$EVIDENCE/public/fixture.log" 2>&1 &
fixture_pid=$!
deadline=$((SECONDS+180))
until test "$(timeout 5 adb -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = 1; do
  kill -0 "$emulator_pid" && kill -0 "$fixture_pid"
  test "$SECONDS" -lt "$deadline"
  sleep 1
done
adb -s emulator-5554 reverse tcp:18789 tcp:18789
"$NODE_EXECUTABLE" "$INPUT/capture-preflight.mjs"
"$NODE_EXECUTABLE" "$INPUT/diagnose-native.mjs" before-app
adb -s emulator-5554 install "$TRIAL/apk/candidate.apk"
adb -s emulator-5554 shell am start -W -n ai.openclaw.app.debug/ai.openclaw.app.MainActivity
"$NODE_EXECUTABLE" "$INPUT/drive.mjs"
