# Third-party software

## Bundled in this repository

### d3 7.9.0: `webroot/lib/vendor/d3.min.js`

https://d3js.org · ISC License

```
Copyright 2010-2023 Mike Bostock

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### Observable Plot 0.6.17: `webroot/lib/vendor/plot.umd.min.js`

https://observablehq.com/plot · ISC License

```
Copyright 2020-2025 Observable, Inc.

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

## Loaded at runtime, not bundled

- **DuckDB-WASM** (MIT): loaded by `webroot/lib/kit.js` from cdn.jsdelivr.net
  in the viewer's browser. The version is `DUCKDB_WASM_VERSION` (default
  1.33.1-dev65.0, which contains DuckDB v1.5.6), kept equal to OpenMausBot's
  DuckDB by `admin/openmausbot-upgrade.sh`.

## Installed with the program, not bundled

- **wrangler** (MIT OR Apache-2.0), Cloudflare's CLI, and its dependencies:
  installed by `admin/install.sh` with `npm ci` from `deploy/package-lock.json`
  (pinned) into `/usr/local/lib/omb-webreports/deploy/node_modules`, for
  `webdata-deploy`.

## Used from the host, not bundled

Installed separately (see docs/setup.md), each under its own license:
OpenMausBot (Apache-2.0), `@duckdb/node-api` (MIT), `@resvg/resvg-js` (MPL-2.0),
agent-browser and Chrome for Testing, Apache httpd (Apache-2.0), Node.js, Tailscale.
