#!/usr/bin/env bash
# Capture before Node parses anything. Only a complete, validated pin report
# reaches the runner; raw streams and all file-command channels stay private.
set -u
umask 077
fail() { printf '%s\n' 'Savings guard pins: check failed; diagnostic details withheld.'; exit 2; }
[ "$#" -eq 0 ] || fail
root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
if ! private="$(mktemp -d "$root/atlas-savings-guard-XXXXXX" 2>/dev/null)"; then fail; fi
for key in GITHUB_STEP_SUMMARY GITHUB_ENV GITHUB_OUTPUT GITHUB_PATH GITHUB_STATE; do
  export "$key=$private/$key.private"
done
unset NODE_OPTIONS NODE_PATH
export ATLAS_PUBLIC_CI=1
# No raw output (including pre-handler syntax/load errors) is forwarded.
{ node scripts/savings-guard-pins.js --check >"$private/stdout" 2>"$private/stderr"; status=$?; } 2>/dev/null
if [ "$status" -ne 0 ] && [ "$status" -ne 1 ]; then fail; fi
# Unexpected stderr is a failure too. In particular, a valid partial report
# cannot turn a runtime warning/error into apparently complete diagnostics.
[ ! -s "$private/stderr" ] || fail
for key in GITHUB_STEP_SUMMARY GITHUB_ENV GITHUB_OUTPUT GITHUB_PATH GITHUB_STATE; do
  [ ! -s "$private/$key.private" ] || fail
done
# Validate the whole report before emitting any line. This validator loads no
# repository JavaScript and never interpolates rejected input into a diagnostic.
if ! LC_ALL=C awk -v status="$status" '
  BEGIN {
    file = "(public/[A-Za-z0-9_-]+[.](js|html)|server[.]js|scripts/[A-Za-z0-9_-]+[.]js|test/(lib/)?[A-Za-z0-9_-]+[.]js|[.]github/workflows/[A-Za-z0-9_-]+[.]yml)"
    entry = file "#((mode|module|residual|deferred|scripts|html|selector-order|machinery)|[A-Za-z_$][A-Za-z0-9_$]*#[1-9][0-9]*(#selector)?)"
    hash = "(-|[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])"
    row = "^(ADDED|REMOVED|CHANGED)  " entry "  " hash " -> " hash "$"
  }
  {
    if (status == 0) {
      if (NR != 1 || $0 != "Savings guard pins: no differences from the committed manifest.") bad = 1
    } else if (NR == 1) {
      if ($0 != "Savings guard pins: differences.") bad = 1
    } else if ($0 == "Savings guard pins: check complete.") {
      if (done || count == 0) bad = 1
      done = 1
    } else {
      if (done || length($2) > 250 || $0 !~ row || seen[$2]++) bad = 1
      if (($1 == "ADDED" && ($3 != "-" || $5 == "-")) ||
          ($1 == "REMOVED" && ($3 == "-" || $5 != "-")) ||
          ($1 == "CHANGED" && ($3 == "-" || $5 == "-"))) bad = 1
      count++
    }
    lines[NR] = $0
  }
  END {
    if (bad || NR == 0 || (status == 1 && !done)) exit 1
    for (i = 1; i <= NR; i++) print lines[i]
  }
' "$private/stdout" 2>/dev/null; then fail; fi
exit "$status"
