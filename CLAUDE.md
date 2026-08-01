# arduino-mcp

**VERSION: 1.1.0** (keep in sync with package.json; bump per change)

Local stdio MCP server that lets Claude Desktop compile Arduino sketches via `arduino-cli` and get structured compiler diagnostics back. Primary consumer: the BasicMicro blog workflow — every complete article sketch must compile clean against its target board before staging. Sibling project: `D:\mcp-servers\wordpress-mcp\bm-mcp-bridge.js` (same conventions: plain Node.js, stdio, no OAuth, minimal dependencies).

## THE RESTART RULE

Any change to `server.js` requires a **full Claude Desktop restart** (quit from the system tray, not just close the window) to take effect. Claude Desktop launches the server process once at startup.

## Architecture

- Plain Node.js, no build step. Entry point: `server.js`. `@modelcontextprotocol/sdk` (pinned 1.30.0) over stdio, `zod` (pinned 4.4.3) for schemas.
- Shells out to `arduino-cli`. Binary resolution order: `bin\arduino-cli.exe` in the project (currently 1.5.1), then PATH. All child-process plumbing goes through one `runCli(args, {timeout, env})` helper — never spawn arduino-cli any other way.
- **Self-contained toolchain**: every arduino-cli invocation gets `ARDUINO_DIRECTORIES_DATA=<project>\data`, `ARDUINO_DIRECTORIES_DOWNLOADS=<data>\downloads`, and `ARDUINO_DIRECTORIES_USER=<data>\user` in its env, plus `--config-file <data>\arduino-cli.yaml` when that file exists (scripts/init.js creates it). Cores, libraries, indexes, and the build cache all live under `data\` and never touch a user-level Arduino IDE install. Note: `directories.user` is where `lib install` puts libraries — it must stay pinned to `data\user`.
- **Sketch handling**: each compile writes the code to `%TEMP%\arduino-mcp\<12-char-sha1-of-code+fqbn>\<name>\<name>.ino` (`<name>` = filename minus `.ino`; arduino-cli requires the .ino basename to equal its parent folder name). Temp dirs older than 24h are deleted opportunistically on startup.
- **Compile command**: `compile --fqbn <fqbn> --json --warnings all --build-cache-path <data>\build-cache <sketchdir>`, 180s timeout with process-tree kill (`taskkill /T /F` on Windows). Compiles are serialized through an in-process queue — no concurrent compiles, avoids build-cache races.
- Server exports its internals (`runCli`, `writeSketch`, `parseCompileResult`, `checkRepoDrift`, …) via `module.exports` and only starts the stdio transport when `require.main === module` — `scripts/smoke.js` exercises the exact same code paths.
- **Repo drift state**: `data\repo-state.json` (gitignored with the rest of `data\`), shape `{ "<owner/name>": { baseline_sha, baseline_date, acknowledged_at, last_checked, last_report } }`. `last_report` is the cached drift report served within the 24h TTL. GitHub calls go through one `fetchJson(url, {timeout, retry, as})` helper (global fetch, Node >= 18; `GITHUB_TOKEN` sent as a bearer header if present in the env, never required). **The baseline ONLY advances on an explicit `acknowledge: true` call** (or when first seen, which bootstraps it) — an unacknowledged drift keeps reporting on every future check. This is the core design decision; do not "helpfully" auto-advance it.

## arduino-cli `--json` layout (verified against 1.5.1 on 2026-08-01)

Do not trust this from memory for other versions — re-verify with a real compile if arduino-cli is upgraded.

- Success: exit 0, top-level `{builder_result, compiler_err, compiler_out, success: true, upload_result, warnings}`.
- Failure: exit 1, `success: false`, plus top-level `error` (e.g. `"Error during build: exit status 1"`); `builder_result.executable_sections_size` is absent.
- `builder_result.diagnostics`: `[{severity: "ERROR"|"WARNING", message (multi-line, includes source excerpt), file, line, column, context?}]`. Server lowercases severity. Fallback when the array is absent: regex-parse gcc `file:line:col: severity: message` lines from `compiler_err`/stderr. On failure a ~2000-char raw stderr excerpt is always included in the result.
- `builder_result.executable_sections_size`: `[{name: "text", size, max_size}, {name: "data", size, max_size}]` → reported as flash (`text`) and RAM (`data`) bytes/max/percent.
- Caveat: with a warm build cache the core isn't rebuilt, so `--warnings all` core warnings (e.g. new.cpp unused-parameter) only appear on cold builds. Sketch-level diagnostics always appear.
- PowerShell gotcha (dev only): piping or `>`-redirecting arduino-cli output through PowerShell 5.1 adds a UTF-8 BOM; stdout captured directly from the spawned process has none. `parseJson()` in server.js strips a leading BOM defensively.

## Board alias map (constant in server.js, reported by arduino_env_info)

| Alias | FQBN |
|---|---|
| uno | arduino:avr:uno |
| leonardo | arduino:avr:leonardo |
| a-star | arduino:avr:leonardo |
| micro | arduino:avr:micro |
| mega | arduino:avr:mega |
| due | arduino:sam:arduino_due_x_dbg |
| esp32 | esp32:esp32:esp32 |
| esp8266 | esp8266:esp8266:nodemcuv2 |
| teensy40 | teensy:avr:teensy40 |

Tools accept an alias or a raw FQBN — anything containing `:` is passed through as-is. Gotcha: sketches using `Serial1` (Basicmicro convention) compile on leonardo/a-star/micro/mega but fail on uno, which has no `Serial1`.

## Tool surface

1. **arduino_compile** — the workhorse. Input: `code` (required, full sketch source), `boards` (array of alias/FQBN, default `["a-star"]`), `filename` (lowercase `*.ino`, default `sketch.ino`), `libraries` (names that must already be installed — verified via `lib list --json`, fails fast with an install hint; never auto-installs). Output `structuredContent`: `{results: [{board, fqbn, ok, diagnostics: [{severity, message, file, line, column}], memory: {flash_bytes, flash_max, flash_pct, ram_bytes, ram_max, ram_pct} | null, duration_ms, raw_stderr_excerpt?}]}`. Annotations: readOnlyHint, idempotentHint. **Drift integration**: when `libraries` includes `Basicmicro` (case-insensitive), a `repo_drift` field for `basicmicro/basicmicro_arduino` is attached alongside `results` — served from the `repo-state.json` cache (24h TTL), with a live check (5s timeout, no retry, runs concurrently with the compiles) only when the cache is stale. The inline check never acknowledges, never blocks, and on failure yields `repo_drift: {checked: false, reason}`; compile results are unchanged otherwise.
2. **arduino_env_info** — cli version/path, data dir, installed cores + libraries with versions, alias map. readOnlyHint.
3. **arduino_install_core** — `core_id` (e.g. `arduino:avr`), optional `board_manager_url` (index for it is updated first). 10-min timeout.
4. **arduino_install_library** — `name` (`Basicmicro` or `Basicmicro@1.0.2`) XOR `git_url` (git installs need `library.enable_unsafe_install`, which init.js sets; the tool also sets the env var belt-and-braces).
5. **arduino_update_indexes** — `core update-index` + `lib update-index`.
6. **arduino_check_repo_drift** — flags when a BasicMicro repo has moved since the last acknowledged review. Input: `repo` (default `basicmicro_arduino`; bare names resolve to the `basicmicro` org, `owner/name` passes through), `acknowledge` (default false — when true, records the current head as the new baseline after reporting; the ONLY way the baseline moves), `force` (default false — bypass the 24h report cache). Behavior: resolves the default branch (`main` then `master`), fetches head via the GitHub commits API (unauthenticated ok, 60 req/hr), and on drift runs the compare API for `ahead_by`, up to 20 new commits (sha7/date/first line), and the unique top-level `touched_paths` (first 300 files). For `basicmicro_arduino` only, also compares the head's `library.properties` `version=` against the installed Basicmicro lib (`installed_version`, `repo_declared_version`, `release_pending`). All network calls: 10s timeout, one retry; on final failure returns a non-error `{checked: false, reason}` — drift checking is advisory and never throws. Description warns that acknowledge mutates the baseline; annotations can't vary per call in MCP, so readOnlyHint is left unset (defaults false) rather than falsely promising read-only.

Convention: every error message names the missing thing and the exact tool call or shell command that fixes it.

## Scripts

- `node scripts\init.js` — one-time setup: config init into `data\arduino-cli.yaml` (board manager URLs for esp32/esp8266/teensy, unsafe lib install enabled, directories pinned), installs cores `arduino:avr`, `arduino:sam`, `esp32:esp32`, `esp8266:esp8266`, `teensy:avr` (teensy optional — warns and continues on failure), installs lib `Basicmicro`, prints a summary table. First run downloads toolchains, takes several minutes.
- `node scripts\smoke.js` — **the smoke test**: compiles a known-good Basicmicro sketch for `leonardo` (expects ok=true with flash/RAM figures), the same sketch minus the include (expects ok=false with a line-numbered error diagnostic), then runs the drift check for `basicmicro_arduino` (passes on either a valid report — baseline recorded or drift status — or a clean offline skip `{checked: false, reason}`; smoke must pass with no network). Exits non-zero on any mismatch. Run after any server.js change. Note: the drift section writes/advances nothing — it never acknowledges — but it does bootstrap a baseline into `data\repo-state.json` on first run.

## Dev / verify workflow

```
node --check server.js          # syntax
node scripts\smoke.js           # compile round-trip through the server's own parse path
npx @modelcontextprotocol/inspector --cli node server.js --method tools/list   # registration
```

## Deploy (Claude Desktop)

`%APPDATA%\Claude\claude_desktop_config.json` under `mcpServers`:

```json
"arduino": {
  "command": "node",
  "args": ["D:\\mcp-servers\\arduino\\server.js"]
}
```

Then fully restart Claude Desktop (tray quit). Verify in a fresh chat: `arduino_env_info`, then compile a sketch for `a-star` expecting ok=true with memory figures.

## Repo conventions

- `package.json` pins exact dependency versions. Version starts at 1.0.0 — bump per change and keep the VERSION line at the top of this file in sync.
- `.gitignore` excludes `node_modules/`, `data/` (the entire self-contained toolchain — gigabytes, machine-local), and `bin/` (the arduino-cli exe).
