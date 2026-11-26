# Run the Atlas demo

From the source checkout, run `node scripts/package-demo.js <new-directory>`.
This assembles the Budget assets and the `stack-card-summary` figures fixture.
The fixture shows one invented household, dated August 20, 2026.
The packager removes household payroll evidence, exact transaction matches,
and household wording from the browser assets. Review those omissions when
adding source that carries household facts.

In the new directory, install dependencies with `npm ci --ignore-scripts`.
Run `node server.js` directly with `ATLAS_DEMO=1` in the process environment
and `PORT` if the service supplies one. The startup allowlist accepts only
those settings, `NODE_ENV`, `PATH`, and the Windows runtime keys listed in
`scripts/demo-server.js`. Check inherited environment keys in the demo service
if startup refuses. Use a dedicated service with a fresh environment.

The demo refuses to boot beside `data.json`, `public/periods.json`, `raw`,
`derived`, or `snapshots`. Use the packaged directory as the service root.
`GET /healthz` reports readiness. The Budget is available at `/` without a
login. Data, assets, and page responses are read-only and kept out of caches.
