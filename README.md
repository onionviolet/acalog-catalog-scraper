# Modern Campus Catalog Exporter

A browser userscript that exports every course from Washington and Lee's Modern Campus Catalog (formerly Acalog) into deterministic, LLM-friendly artifacts. Authentication and anti-bot state stay inside the user's normal browser session.

The exporter discovers the catalog's real page count, fetches every page with bounded backoff, and refuses to save a partial result. It parses each course into stable fields and can restrict the output to selected department prefixes.

## Features
* **Structured output:** full Markdown and JSON snapshots with code, title, prerequisites, corequisites, FDR, credits, and description.
* **Per-department archive:** a tar archive containing `_INDEX.md` and one Markdown file per prefix, including rough token estimates.
* **Mechanical change detection:** after the first run, each export includes a compact JSON diff against the browser's previous snapshot.
* **Completeness evidence:** output records expected and fetched page counts, source URL, catalog identifiers, capture time, and stable course fingerprints.
* **Fail-closed collection:** a missing, empty, or persistently throttled page produces no artifacts.
* **No credentials:** the script uses same-origin browser requests and never copies cookies or creates tokens.

## How to Use

1. Install `dist/acalog-catalog-export.user.js` in a userscript manager.
2. Open the catalog's Courses page in the normal browser session.
3. Click **Export catalog**. Enter comma-separated department prefixes such as `CSCI,MATH`, or leave the field empty for the full catalog.
4. Keep the page open until the green status banner reports all pages fetched. The browser downloads JSON, Markdown, and a per-department tar archive. A diff also downloads when a previous snapshot exists.

Chrome may ask whether the catalog site can download multiple files. Allow it only for this site if you want all artifacts.

## How it Works
`src/catalog-core.js` owns deterministic parsing, rendering, fingerprints, and diffs. `src/browser.js` owns same-origin collection and downloads. `npm run build` creates the installable userscript. `npm test` runs parser, filtering, diff, department-output, and syntax checks without network access.

The older `catalog_grabber_v2.js` and `screaper code.js` remain as historical standalone console scripts. New work belongs in `src/` and the generated `dist/` file.

## Development

```bash
npm run build
npm test
npm run check
```
