#!/usr/bin/env node
/**
 * Export Figma nodes as local image files via the Figma REST API.
 * Node 18+, zero dependencies.
 *
 * Usage:
 *   node scripts/figma-export.mjs --file <fileKey> --out <dir> [--format png|jpg|svg|pdf] [--scale 1] [--chunk 1] \
 *     --map "12:34=hero-banner,12:56=footer-card"
 *   node scripts/figma-export.mjs --file <fileKey> --list-pages
 *
 * Token: FIGMA_ACCESS_TOKEN env var, or a FIGMA_ACCESS_TOKEN=... line in ./.env.local
 */
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  if (def !== undefined) return def;
  console.error(`missing --${name}`);
  process.exit(1);
}

async function token() {
  if (process.env.FIGMA_ACCESS_TOKEN) return process.env.FIGMA_ACCESS_TOKEN;
  const envLocal = path.resolve(process.cwd(), ".env.local");
  if (existsSync(envLocal)) {
    const m = (await readFile(envLocal, "utf8")).match(/^FIGMA_ACCESS_TOKEN=(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  console.error("FIGMA_ACCESS_TOKEN not set (env or .env.local)");
  process.exit(1);
}

async function listPages(fileKey, tok) {
  const res = await fetch(`https://api.figma.com/v1/files/${fileKey}?depth=1`, {
    headers: { "X-Figma-Token": tok },
  });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${await res.text()}`);
  const { name, document } = await res.json();
  console.log(`File: ${name}`);
  for (const page of document.children ?? []) {
    console.log(`${page.id}\t${page.name}`);
  }
}

async function main() {
  const fileKey = arg("file");
  if (process.argv.includes("--list-pages")) {
    return listPages(fileKey, await token());
  }
  const outDir = arg("out");
  const format = arg("format", "png");
  const scale = arg("scale", "1");
  const chunkSize = Number(arg("chunk", "1")); // large print frames time out when batched
  const map = new Map(
    arg("map").split(",").map((pair) => {
      const [id, name] = pair.split("=");
      return [id.trim(), name.trim()];
    }),
  );
  const tok = await token();
  await mkdir(outDir, { recursive: true });

  const ids = [...map.keys()];
  const images = {};
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const qs = new URLSearchParams({ ids: chunk.join(","), format, scale });
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(`https://api.figma.com/v1/images/${fileKey}?${qs}`, {
        headers: { "X-Figma-Token": tok },
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && !body.err) { Object.assign(images, body.images); break; }
      const msg = body.err ?? `HTTP ${res.status}`;
      if (attempt >= 4) throw new Error(`Figma render failed for [${chunk.join(",")}]: ${msg}`);
      console.warn(`retry ${attempt}/3 for [${chunk.join(",")}]: ${msg}`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }

  let saved = 0;
  for (const [nodeId, name] of map) {
    const url = images[nodeId];
    if (!url) { console.warn(`skip ${nodeId} (${name}): render failed`); continue; }
    const img = await fetch(url);
    if (!img.ok) { console.warn(`skip ${nodeId} (${name}): download ${img.status}`); continue; }
    const out = path.join(outDir, `${name}.${format}`);
    await writeFile(out, Buffer.from(await img.arrayBuffer()));
    console.log(`saved ${out}`);
    saved++;
  }
  console.log(`${saved}/${map.size} exported`);
  if (saved !== map.size) process.exit(1);
}

main().catch((e) => { console.error("Export failed:", e.message); process.exit(1); });
