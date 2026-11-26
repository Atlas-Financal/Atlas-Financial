# Run the Atlas demo

From the source checkout, run `node scripts/package-demo.js <new-directory>`.
This assembles the Budget assets and the `stack-card-summary` figures fixture.
The fixture shows one invented household, dated August 20, 2026.
The packager removes household payroll evidence, exact transaction matches,
and household display exceptions from the browser assets. It uses Atlas's
privacy fingerprints and checks the approved SHA-256 digests for the prepared
assets and fixture. Startup verifies those digests before opening the port.

Approved digests live one file per asset under `scripts/demo-asset-digests/`
(`<asset-path>.sha256`). Binary assets store one whole-file SHA-256 hash; text
assets store the ordered SHA-256 hashes of content-defined line chunks whose
concatenation equals the prepared asset byte for byte. Any byte change, line
edit, insertion, deletion, reorder or duplication still fails packaging and
startup, while edits to different assets or non-adjacent regions of one asset
touch separate files or hash lines and merge cleanly in git. Missing, stray,
symlinked or malformed digest files fail closed.

When a shared asset changes, review the prepared asset before updating its
digest:
- `node scripts/demo-asset-digests.js --check` reports any asset whose prepared
  output differs from `scripts/demo-asset-digests/` (read-only; exits 1 on diff).
- `node scripts/demo-asset-digests.js --write` checks privacy on every prepared
  asset and updates only the differing `.sha256` files. It does not replace
  reviewing the prepared demo asset, and CI never runs `--write`.
- A branch created before the directory layout that still carries the retired
  `scripts/demo-asset-digests.json` resolves the rename once after merging
  `main` with `git rm -f scripts/demo-asset-digests.json` and then running
  `node scripts/demo-asset-digests.js --write` after reviewing its prepared
  asset diff.

In the new directory, install dependencies with `npm ci --ignore-scripts`.
Run `node server.js` directly with `ATLAS_DEMO=1` in the process environment
and `PORT` if the service supplies one. The startup allowlist accepts only
those settings, `NODE_ENV`, `PATH`, and the Windows runtime keys listed in
`scripts/demo-server.js`. Check inherited environment keys in the demo service
if startup refuses. Use a dedicated service with a fresh environment.

The demo refuses to boot beside `data.json`, `public/periods.json`, `raw`,
`derived`, `snapshots`, `statements/`, `statements-*/`, `.env`, dotenv variants,
or the repository's local credential files. It checks the packaged application directories and the
working directory before loading fixtures or opening a port.
Use the packaged directory as the service root.
`GET /healthz` reports readiness. The Budget is available at `/` without a
login. Data, assets, and page responses are read-only and kept out of caches.
