# figma-asset-export-skill

An [Agent Skill](https://docs.claude.com/en/docs/agents-and-tools/agent-skills) + zero-dependency Node script for pulling **production-ready image assets out of Figma** — without burning MCP screenshot round-trips.

Works with Claude Code, Cursor, or any agent that can run a shell command.

## The problem

When an AI agent works a Figma file through MCP, the default way to "get an image" is the `get_screenshot` tool. That's built for *visual context*, not asset pipelines:

- One tool call per node — exporting 14 boards × 4 frames = **56 round-trips**
- Returns **short-lived URLs** you must download before they expire
- No local files unless you bolt on a download step per call

For a real export job (print files, marketing assets, batch renders) this is slow and fragile.

## The fix

Figma's plain REST API renders any node to a file in **one batched request**:

```
GET https://api.figma.com/v1/images/:file_key?ids=1:2,1:3&format=jpg&scale=2
Header: X-Figma-Token: <personal access token>
```

This repo packages that as:

- **[`SKILL.md`](SKILL.md)** — drop-in agent skill that steers the agent away from the screenshot loop and toward the REST flow
- **[`scripts/figma-export.mjs`](scripts/figma-export.mjs)** — parameterized exporter (Node 18+, no dependencies): chunking, retries, name-mapped output files

Measured on a real print pipeline (4 print-resolution frames per board): **~5s per board** via REST vs. minutes of per-frame tool calls — and ~50 fewer round-trips across a 14-board job.

## Token setup (one time)

1. Figma → **Settings → Security → Personal access tokens** → generate a token with **File content: read** scope.
2. Make it available to every project on your machine:

   **Windows**
   ```powershell
   setx FIGMA_ACCESS_TOKEN "figd_..."
   ```
   Note: `setx` only affects *new* processes — restart your terminal/editor. Already-running apps keep their old environment.

   **macOS / Linux**
   ```bash
   echo 'export FIGMA_ACCESS_TOKEN="figd_..."' >> ~/.zshrc   # or ~/.bashrc
   ```

3. Per-repo fallback (picked up immediately, no restart): put `FIGMA_ACCESS_TOKEN=figd_...` in a **gitignored** `.env.local`. The script checks the env var first, then `.env.local`.

**Don'ts:** never commit the token, never paste it into an AI chat, and don't reach for Vercel/CI env vars for this — those only exist inside the deployed runtime, not your local tooling.

## Usage

```bash
node scripts/figma-export.mjs \
  --file YOUR_FILE_KEY \
  --out ./exports \
  --format png --scale 1 \
  --map "12:34=hero-banner,12:56=footer-card"
```

- `--file` — from the Figma URL: `figma.com/design/<FILE_KEY>/...`
- `--map` — `nodeId=outputName` pairs, comma-separated (node ids from the URL's `node-id=12-34` → `12:34`)
- `--format` — `png` (default) | `jpg` | `svg` | `pdf`
- `--scale` — 0.01–4; `1` = the frame's native size
- `--chunk` — nodes per API request (default `1`; see gotchas)

### Installing the skill

Copy `SKILL.md` into a `figma-designer/` folder in your skills directory:

- Claude Code: `~/.claude/skills/figma-designer/SKILL.md`
- Cursor: `~/.cursor/skills/figma-designer/SKILL.md`
- Project-scoped: `<repo>/.claude/skills/` or `<repo>/.cursor/skills/`

## Gotchas (learned the hard way)

| Gotcha | Detail |
|---|---|
| `scale` clamps to 0.01–4 | Build frames at output resolution and export at `scale: 1` for print work |
| Render URLs are temporary | ~14 days, but treat as ephemeral — download immediately, never store URLs |
| `400 Render timeout` | Very large frames (e.g. 7200×10800 print frames) fail when batched. Chunk heavy nodes one-per-request and retry with backoff — Figma's render cache usually makes the retry succeed |
| Rotated frames | Export at their *rendered* bounding box (a 90°-rotated 3000×2400 frame exports as 2400×3000) |
| `null` in the `images` map | That node failed to render (bad id, empty frame) — skip it, don't crash |
| `png` vs `jpg` | Use `png` when the file feeds a downstream re-encode (print pipelines) to avoid double JPEG compression; `jpg` for direct web-ready assets |
| Rate limits | Per-token — prefer batching, except where the render-timeout gotcha applies |

## License

[MIT](LICENSE)
