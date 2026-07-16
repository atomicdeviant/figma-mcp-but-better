---
name: figma-designer
description: Efficient Figma asset extraction — skip get_screenshot; export frames/components as local JPG/PNG files via the Figma REST API (GET /v1/images/:key). Use when exporting Figma assets to disk, building asset pipelines, or batch-rendering print/production files from Figma.
---

# Skill: Efficient Figma Asset Extraction (JPG Pipeline)

## Context
When interacting with Figma files via MCP, the default behavior often relies heavily on the `get_screenshot` tool. This generates high-fidelity, short-lived PNG URLs designed solely for visual LLM context. It does not export reusable image files to the local environment, requires one tool round-trip per node, and the URLs expire quickly — inefficient for asset pipelines.

## Objective
Override the default "screenshot-as-context" loop. Instead, extract structural node data via MCP, then pull production-ready image assets directly from the Figma REST API with a local script — all node IDs in ONE API call (chunking only for oversized frames).

## Requirements
- `FIGMA_ACCESS_TOKEN` env var: a Figma **personal access token** (Figma → Settings → Security → Personal access tokens, `file_content:read` scope). Never paste tokens into chat or commit them; set via `.env.local` or the shell.
- Node 18+ (native `fetch` — no dependencies).

## Execution Rules

### 1. Disable Visual Screenshots
* **DO NOT** invoke the `get_screenshot` tool unless explicitly requested for design validation (or when no REST token is available).
* Avoid using high-resolution image rendering for structural analysis or layout interpretation.

### 2. Prioritize Data & Code Context
* Use structural tools like `get_design_context`, `get_metadata`, or read-only Plugin API queries to read node IDs, layout properties, and typography tokens.
* Focus entirely on the node data rather than visual rendering.

### 3. Resolve Pages Before Drilling In
Figma pages (the left-sidebar list) are top-level CANVAS nodes, each with its own node ID. A pasted Figma URL only carries the `?node-id=` of whatever the user was viewing — other pages are invisible from that anchor. **If the user references a page by name, or the target frames may live on a different page than the URL's node-id:**
1. Enumerate pages first: `GET /v1/files/:key?depth=1` (returns every page's ID + name in one cheap call), or run `node scripts/figma-export.mjs --file <fileKey> --list-pages`.
2. Resolve the named page to its canvas node ID.
3. List that page's frames: `GET /v1/files/:key/nodes?ids=<pageId>&depth=2`.

Never assume the URL's node-id page is the whole file.

### 4. Build the Minimum
Build only what the request needs. No retries, config flags, output formats, abstractions, or extra frames/variants unless explicitly asked. One frame requested = one frame delivered. When exporting, prefer running the existing `scripts/figma-export.mjs` over generating a new script.

### 5. Implement the Export Flow
When tasked with exporting frames, components, or layers, generate or execute a local script against the official Figma REST API endpoint (`GET /v1/images/:key`). Batch node IDs into a single request (`ids` is comma-separated).

#### Local Export Script Template (Node.js 18+, no dependencies)

```javascript
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const FIGMA_TOKEN = process.env.FIGMA_ACCESS_TOKEN;
const FILE_KEY = 'YOUR_FILE_KEY';                 // from figma.com/design/:fileKey/...
const NODE_IDS = ['12:34', '12:56'];              // node ids to export
const FORMAT = 'jpg';                             // jpg | png | svg | pdf
const SCALE = 2;                                  // 0.01 – 4 (1 = native frame size)
const OUT_DIR = './exports';

async function exportFigmaImages() {
  if (!FIGMA_TOKEN) throw new Error('FIGMA_ACCESS_TOKEN is not set');
  await mkdir(OUT_DIR, { recursive: true });

  // 1. Request render URLs for ALL nodes in one call
  const qs = new URLSearchParams({ ids: NODE_IDS.join(','), format: FORMAT, scale: String(SCALE) });
  const res = await fetch(`https://api.figma.com/v1/images/${FILE_KEY}?${qs}`, {
    headers: { 'X-Figma-Token': FIGMA_TOKEN },
  });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  const { images, err } = await res.json();
  if (err) throw new Error(`Figma render error: ${err}`);

  // 2. Download each rendered image to disk (awaited — no fire-and-forget streams)
  for (const [nodeId, url] of Object.entries(images)) {
    if (!url) { console.warn(`skip ${nodeId}: render failed`); continue; }
    const out = path.resolve(OUT_DIR, `image-${nodeId.replace(':', '-')}.${FORMAT}`);
    const img = await fetch(url);
    if (!img.ok) { console.warn(`skip ${nodeId}: download ${img.status}`); continue; }
    await writeFile(out, Buffer.from(await img.arrayBuffer()));
    console.log(`Saved: ${out}`);
  }
}

exportFigmaImages().catch((e) => { console.error('Export failed:', e.message); process.exit(1); });
```

For a parameterized CLI version with chunking and retries, see `scripts/figma-export.mjs` in this repo.

## Gotchas
- `scale` is clamped to **0.01–4**. Frames built at print resolution export 1:1 with `scale: 1`.
- Render URLs returned by the API are **temporary (~14 days)** — download immediately, never store the URLs.
- Rotated frames export at their **rendered** bounding box (a 90°-rotated 3000×2400 frame exports as 2400×3000).
- A `null` entry in `images` means that node failed to render (bad id, empty frame) — handle it, don't crash.
- Use `format: 'png'` when the file feeds a downstream re-encode (e.g. print pipelines) to avoid double JPEG compression; use `jpg` for direct web-ready assets.
- Rate limits apply per token — prefer batching ids into one call, BUT very large frames (print-resolution, e.g. 7200×10800) can return `400 "Render timeout"` when batched. Chunk heavy nodes into separate requests and retry with backoff — Figma's render cache usually makes the retry succeed.
