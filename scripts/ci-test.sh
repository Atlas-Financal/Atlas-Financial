#!/usr/bin/env bash
# Establish private streams before Node can parse or load any repository module.
# A separate validator reconstructs public records. No raw stream is forwarded.
set -u
umask 077
case "${1-}" in
  standard|refresh-isolation|install-runtime|install-test) group="$1" ;;
  *) printf '%s\n' '{"type":"ci-worker-error","category":"invalid-configuration","exitCode":1}'; exit 1 ;;
esac
if [ "$#" -ne 1 ]; then
  printf '%s\n' '{"type":"ci-worker-error","category":"invalid-configuration","exitCode":1}'
  exit 1
fi
root="${ATLAS_CI_DIAGNOSTICS_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}}"
if ! mkdir -p -- "$root" 2>/dev/null || ! private="$(mktemp -d "$root/atlas-ci-bootstrap-XXXXXX" 2>/dev/null)"; then
  printf '%s\n' '{"type":"ci-worker-error","category":"capture-failed","exitCode":1}'
  exit 1
fi
export ATLAS_CI_BOOTSTRAP_DIR="$private" ATLAS_PUBLIC_CI=1
for key in GITHUB_STEP_SUMMARY GITHUB_ENV GITHUB_OUTPUT GITHUB_PATH GITHUB_STATE; do
  if [ -n "${!key-}" ]; then export "$key=$private/$key.private"; fi
done
printf '{"type":"ci-worker-start","identity":"%s"}\n' "$group"
# Clear optional Node preloads before either launcher or validator starts.
# The validator retains raw stdout privately, and neither Node process can
# publish its bootstrap stderr. Preserve the launcher's original failure status;
# a failed validator can only turn a successful launch into a failure.
unset NODE_OPTIONS NODE_PATH
{ node scripts/ci-test.js "$group" 2>"$private/bootstrap.stderr.log" \
  | node scripts/ci-test-records.js "$group" 2>"$private/relay.stderr.log"
  statuses=("${PIPESTATUS[@]}")
} 2>/dev/null
status="${statuses[0]}"
if [ "$status" -eq 0 ] && [ "${statuses[1]}" -ne 0 ]; then status=1; fi
printf '{"type":"ci-worker-exit","identity":"%s","exitCode":%d}\n' "$group" "$status"
exit "$status"
