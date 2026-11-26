# Run the Atlas demo

From the source checkout, run `node scripts/package-demo.js <new-directory>`.
This assembles the Budget assets and the `stack-card-summary` figures fixture.
The fixture shows one invented household, dated August 20, 2026.
The packager removes household payroll evidence, exact transaction matches,
and household display exceptions from the browser assets. It uses Atlas's
privacy fingerprints and checks the approved SHA-256 digests for the prepared
assets and fixture. Startup verifies those digests before opening the port.
When a shared asset changes, review the prepared asset before updating its
digest in `scripts/demo-asset-digests.json`.

In the new directory, install dependencies with `npm ci --ignore-scripts`.
Run `node server.js` directly with `ATLAS_DEMO=1` in the process environment
and `PORT` if the service supplies one. The startup allowlist accepts only
those settings, `NODE_ENV`, `PATH`, and the Windows runtime keys listed in
`scripts/demo-server.js`. Check inherited environment keys in the demo service
if startup refuses. Use a dedicated service with a fresh environment.

The demo refuses to boot beside `data.json`, `public/periods.json`, `raw`,
`derived`, `snapshots`, `.env`, dotenv variants, or the repository's local
credential files. It checks the packaged application directories and the
working directory before loading fixtures or opening a port.
Use the packaged directory as the service root.
`GET /healthz` reports readiness. The Budget is available at `/` without a
login. Data, assets, and page responses are read-only and kept out of caches.
