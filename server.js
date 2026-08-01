#!/usr/bin/env node
// arduino-mcp - local stdio MCP server that compiles Arduino sketches via arduino-cli.
// See CLAUDE.md for architecture, conventions, and the deploy protocol.

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT_ROOT = __dirname;
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const DOWNLOADS_DIR = path.join(DATA_DIR, "downloads");
const USER_DIR = path.join(DATA_DIR, "user"); // sketchbook + installed libraries
const CONFIG_FILE = path.join(DATA_DIR, "arduino-cli.yaml");
const BUILD_CACHE_DIR = path.join(DATA_DIR, "build-cache");
const TEMP_ROOT = path.join(os.tmpdir(), "arduino-mcp");
const COMPILE_TIMEOUT_MS = 180_000;
const INSTALL_TIMEOUT_MS = 600_000;
const STDERR_EXCERPT_CHARS = 2000;

// Alias -> FQBN. Anything containing ":" is treated as a raw FQBN and passed through.
const BOARD_ALIASES = {
  uno: "arduino:avr:uno",
  leonardo: "arduino:avr:leonardo",
  "a-star": "arduino:avr:leonardo",
  micro: "arduino:avr:micro",
  mega: "arduino:avr:mega",
  due: "arduino:sam:arduino_due_x_dbg",
  esp32: "esp32:esp32:esp32",
  esp8266: "esp8266:esp8266:nodemcuv2",
  teensy40: "teensy:avr:teensy40",
};

// ---------------------------------------------------------------------------
// arduino-cli plumbing
// ---------------------------------------------------------------------------

let cachedCliPath = null;

function resolveCli() {
  if (cachedCliPath) return cachedCliPath;
  const bundled = path.join(PROJECT_ROOT, "bin", "arduino-cli.exe");
  if (fs.existsSync(bundled)) {
    cachedCliPath = bundled;
    return bundled;
  }
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, "arduino-cli" + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          cachedCliPath = candidate;
          return candidate;
        }
      } catch {
        /* unreadable PATH entry */
      }
    }
  }
  throw new Error(
    `arduino-cli not found. Looked for ${bundled} and then arduino-cli on PATH. ` +
      `Fix: winget install ArduinoSA.CLI, or download the Windows zip from ` +
      `https://arduino.github.io/arduino-cli and drop arduino-cli.exe into ${path.join(PROJECT_ROOT, "bin")}\\`
  );
}

// Single helper for every arduino-cli invocation. Kills the whole process tree on timeout.
function runCli(args, { timeout = COMPILE_TIMEOUT_MS, env = {} } = {}) {
  const cli = resolveCli();
  const fullArgs = fs.existsSync(CONFIG_FILE) ? ["--config-file", CONFIG_FILE, ...args] : args;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(cli, fullArgs, {
      windowsHide: true,
      env: {
        ...process.env,
        ARDUINO_DIRECTORIES_DATA: DATA_DIR,
        ARDUINO_DIRECTORIES_DOWNLOADS: DOWNLOADS_DIR,
        ARDUINO_DIRECTORIES_USER: USER_DIR,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
      } else {
        child.kill("SIGKILL");
      }
    }, timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + "\n" + err.message, timedOut, duration_ms: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, duration_ms: Date.now() - started });
    });
  });
}

// Compiles are serialized through this queue to avoid build-cache races.
let compileQueue = Promise.resolve();
function enqueueCompile(fn) {
  const run = compileQueue.then(fn, fn);
  compileQueue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Sketch + diagnostics helpers
// ---------------------------------------------------------------------------

function resolveBoard(spec) {
  if (spec.includes(":")) return { board: spec, fqbn: spec };
  const fqbn = BOARD_ALIASES[spec.toLowerCase()];
  if (!fqbn) {
    throw new Error(
      `Unknown board alias "${spec}". Known aliases: ${Object.keys(BOARD_ALIASES).join(", ")}. ` +
        `Or pass a raw FQBN (anything containing ":") such as arduino:avr:uno.`
    );
  }
  return { board: spec.toLowerCase(), fqbn };
}

// arduino-cli requires <dir>/<name>/<name>.ino where basename == parent folder name.
function writeSketch(code, fqbn, filename) {
  const name = path.basename(filename, ".ino");
  const hash = crypto.createHash("sha1").update(code).update("\0").update(fqbn).digest("hex").slice(0, 12);
  const sketchDir = path.join(TEMP_ROOT, hash, name);
  fs.mkdirSync(sketchDir, { recursive: true });
  fs.writeFileSync(path.join(sketchDir, name + ".ino"), code, "utf8");
  return sketchDir;
}

function cleanupOldTempDirs() {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(TEMP_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(TEMP_ROOT, entry.name);
      try {
        if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* opportunistic - ignore */
      }
    }
  } catch {
    /* TEMP_ROOT may not exist yet */
  }
}

function parseJson(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip UTF-8 BOM
  return JSON.parse(text);
}

const GCC_DIAG_RE = /^(.+?):(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.*)$/gm;

function parseGccDiagnostics(text) {
  const diags = [];
  for (const m of text.matchAll(GCC_DIAG_RE)) {
    diags.push({
      severity: m[4] === "warning" ? "warning" : m[4] === "note" ? "note" : "error",
      message: m[5].trim(),
      file: m[1],
      line: Number(m[2]),
      column: Number(m[3]),
    });
  }
  return diags;
}

// Field layout verified against real `arduino-cli compile --json` output during development
// (see CLAUDE.md "JSON layout" note for the installed version's actual shape).
function parseCompileResult(board, fqbn, res) {
  let json = null;
  try {
    json = parseJson(res.stdout);
  } catch {
    /* no JSON on stdout (e.g. CLI-level failure) - fall back to stderr parsing */
  }
  const builder = json && json.builder_result ? json.builder_result : {};
  const compilerErr = (json && json.compiler_err) || "";
  const cliError = (json && json.error) || "";
  const stderrText = [compilerErr, cliError, res.stderr].filter(Boolean).join("\n").trim();
  const ok = !res.timedOut && res.code === 0 && (json ? json.success !== false : true);

  let diagnostics = [];
  if (Array.isArray(builder.diagnostics) && builder.diagnostics.length > 0) {
    diagnostics = builder.diagnostics.map((d) => ({
      severity: String(d.severity || "error").toLowerCase(),
      message: d.message || "",
      file: d.file || "",
      line: d.line ?? null,
      column: d.column ?? null,
    }));
  } else {
    diagnostics = parseGccDiagnostics(stderrText);
  }
  if (!ok && diagnostics.length === 0) {
    diagnostics = [
      {
        severity: "error",
        message: res.timedOut
          ? `Compile timed out after ${COMPILE_TIMEOUT_MS / 1000}s (process tree killed).`
          : cliError || stderrText.split("\n").pop() || `arduino-cli exited with code ${res.code}`,
        file: "",
        line: null,
        column: null,
      },
    ];
  }

  let memory = null;
  const sections = builder.executable_sections_size;
  if (Array.isArray(sections)) {
    const flash = sections.find((s) => s.name === "text");
    const ram = sections.find((s) => s.name === "data");
    const pct = (sz, max) => (max ? Math.round((sz / max) * 1000) / 10 : null);
    memory = {
      flash_bytes: flash ? flash.size : null,
      flash_max: flash ? flash.max_size : null,
      flash_pct: flash ? pct(flash.size, flash.max_size) : null,
      ram_bytes: ram ? ram.size : null,
      ram_max: ram ? ram.max_size : null,
      ram_pct: ram ? pct(ram.size, ram.max_size) : null,
    };
  }

  const result = { board, fqbn, ok, diagnostics, memory, duration_ms: res.duration_ms };
  if (!ok && stderrText) {
    result.raw_stderr_excerpt = stderrText.slice(-STDERR_EXCERPT_CHARS);
  }
  return result;
}

async function listInstalledLibraries() {
  const res = await runCli(["lib", "list", "--json"], { timeout: 60_000 });
  try {
    const json = parseJson(res.stdout);
    return (json.installed_libraries || []).map((e) => ({
      name: e.library?.name || "",
      version: e.library?.version || "",
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// MCP server + tools
// ---------------------------------------------------------------------------

const server = new McpServer({ name: "arduino-mcp", version: "1.0.0" });

const diagnosticSchema = z.object({
  severity: z.string(),
  message: z.string(),
  file: z.string(),
  line: z.number().nullable(),
  column: z.number().nullable(),
});

const compileResultSchema = z.object({
  board: z.string(),
  fqbn: z.string(),
  ok: z.boolean(),
  diagnostics: z.array(diagnosticSchema),
  memory: z
    .object({
      flash_bytes: z.number().nullable(),
      flash_max: z.number().nullable(),
      flash_pct: z.number().nullable(),
      ram_bytes: z.number().nullable(),
      ram_max: z.number().nullable(),
      ram_pct: z.number().nullable(),
    })
    .nullable(),
  duration_ms: z.number(),
  raw_stderr_excerpt: z.string().optional(),
});

function textResult(structured, isError = false) {
  const out = { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }] };
  if (isError) out.isError = true;
  else out.structuredContent = structured;
  return out;
}

function errorResult(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

server.registerTool(
  "arduino_compile",
  {
    title: "Compile Arduino sketch",
    description:
      "Compile an Arduino sketch (full source in `code`) against one or more boards and return structured " +
      "compiler diagnostics plus flash/RAM usage. Boards are aliases (uno, leonardo, a-star, micro, mega, due, " +
      "esp32, esp8266, teensy40) or raw FQBNs. Compiles are serialized; each board compile has a 180s timeout.",
    inputSchema: {
      code: z.string().min(1).describe("Full sketch source (the .ino contents)"),
      boards: z
        .array(z.string())
        .default(["a-star"])
        .describe("Board aliases and/or raw FQBNs to compile against (default: [\"a-star\"])"),
      filename: z
        .string()
        .regex(/^[a-z0-9_-]+\.ino$/, "must be a lowercase *.ino basename (no paths)")
        .default("sketch.ino")
        .describe("Sketch filename, lowercase *.ino (default sketch.ino)"),
      libraries: z
        .array(z.string())
        .optional()
        .describe("Library names that must already be installed; compile fails fast if any is missing"),
    },
    outputSchema: { results: z.array(compileResultSchema) },
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ code, boards, filename, libraries }) => {
    let targets;
    try {
      targets = boards.map(resolveBoard);
    } catch (err) {
      return errorResult(err.message);
    }

    if (libraries && libraries.length > 0) {
      const installed = await listInstalledLibraries();
      const installedNames = new Set(installed.map((l) => l.name.toLowerCase()));
      const missing = libraries.filter((l) => !installedNames.has(l.toLowerCase()));
      if (missing.length > 0) {
        return errorResult(
          `Missing librar${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}. ` +
            `Install with the arduino_install_library tool (e.g. {"name": "${missing[0]}"}) ` +
            `or: arduino-cli lib install "${missing[0]}"`
        );
      }
    }

    const results = [];
    for (const { board, fqbn } of targets) {
      const result = await enqueueCompile(async () => {
        const sketchDir = writeSketch(code, fqbn, filename);
        const res = await runCli(
          ["compile", "--fqbn", fqbn, "--json", "--warnings", "all", "--build-cache-path", BUILD_CACHE_DIR, sketchDir],
          { timeout: COMPILE_TIMEOUT_MS }
        );
        return parseCompileResult(board, fqbn, res);
      });
      results.push(result);
    }
    return textResult({ results });
  }
);

server.registerTool(
  "arduino_env_info",
  {
    title: "Arduino environment info",
    description:
      "Report arduino-cli version and path, the self-contained data directory, installed cores and libraries " +
      "with versions, and the board alias map.",
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () => {
    let cliPath;
    try {
      cliPath = resolveCli();
    } catch (err) {
      return errorResult(err.message);
    }
    const [ver, cores, libsRes] = await Promise.all([
      runCli(["version", "--json"], { timeout: 30_000 }),
      runCli(["core", "list", "--json"], { timeout: 60_000 }),
      listInstalledLibraries(),
    ]);
    let version = ver.stdout.trim();
    try {
      const vj = parseJson(ver.stdout);
      version = vj.VersionString || vj.version || version;
    } catch {
      /* keep raw */
    }
    let installedCores = [];
    try {
      const cj = parseJson(cores.stdout);
      installedCores = (cj.platforms || []).map((p) => ({
        id: p.id,
        installed_version: p.installed_version || p.installed || "",
        name: p.releases && p.installed_version ? p.releases[p.installed_version]?.name || "" : p.name || "",
      }));
    } catch {
      /* no cores yet */
    }
    return textResult({
      arduino_cli_version: version,
      arduino_cli_path: cliPath,
      data_dir: DATA_DIR,
      config_file: fs.existsSync(CONFIG_FILE) ? CONFIG_FILE : null,
      installed_cores: installedCores,
      installed_libraries: libsRes,
      board_aliases: BOARD_ALIASES,
    });
  }
);

server.registerTool(
  "arduino_install_core",
  {
    title: "Install Arduino core",
    description:
      "Install a board core (e.g. arduino:avr, esp32:esp32). If the core needs a third-party board manager URL, " +
      "pass board_manager_url; the index for that URL is updated first. Long-running (up to 10 min).",
    inputSchema: {
      core_id: z.string().min(1).describe("Core id, e.g. arduino:avr or esp32:esp32"),
      board_manager_url: z.string().url().optional().describe("Additional board manager index URL, if required"),
    },
  },
  async ({ core_id, board_manager_url }) => {
    const extra = board_manager_url ? ["--additional-urls", board_manager_url] : [];
    const upd = await runCli(["core", "update-index", ...extra], { timeout: INSTALL_TIMEOUT_MS });
    if (upd.code !== 0) {
      return errorResult(
        `core update-index failed (exit ${upd.code}${upd.timedOut ? ", timed out" : ""}):\n` +
          upd.stderr.slice(-STDERR_EXCERPT_CHARS) +
          `\nCheck network access and the board_manager_url, or run arduino_update_indexes first.`
      );
    }
    const inst = await runCli(["core", "install", core_id, ...extra], { timeout: INSTALL_TIMEOUT_MS });
    if (inst.code !== 0) {
      return errorResult(
        `core install ${core_id} failed (exit ${inst.code}${inst.timedOut ? ", timed out" : ""}):\n` +
          inst.stderr.slice(-STDERR_EXCERPT_CHARS) +
          `\nIf the core is third-party, pass its board_manager_url (esp32: https://espressif.github.io/arduino-esp32/package_esp32_index.json).`
      );
    }
    return textResult({ ok: true, core_id, detail: (inst.stdout + inst.stderr).trim().slice(-1000) });
  }
);

server.registerTool(
  "arduino_install_library",
  {
    title: "Install Arduino library",
    description:
      "Install a library by registry name (optionally with @version, e.g. Basicmicro@1.0.2) or from a git URL. " +
      "Provide exactly one of name or git_url. Long-running (up to 10 min).",
    inputSchema: {
      name: z.string().optional().describe("Library name in the Arduino registry, optionally Name@x.y.z"),
      git_url: z.string().url().optional().describe("Git repository URL to install from"),
    },
  },
  async ({ name, git_url }) => {
    if (!name === !git_url) {
      return errorResult('Provide exactly one of "name" or "git_url".');
    }
    const args = git_url ? ["lib", "install", "--git-url", git_url] : ["lib", "install", name];
    const res = await runCli(args, {
      timeout: INSTALL_TIMEOUT_MS,
      // Belt-and-braces: git installs need unsafe install enabled even if init.js hasn't run.
      env: git_url ? { ARDUINO_LIBRARY_ENABLE_UNSAFE_INSTALL: "true" } : {},
    });
    if (res.code !== 0) {
      return errorResult(
        `lib install failed (exit ${res.code}${res.timedOut ? ", timed out" : ""}):\n` +
          res.stderr.slice(-STDERR_EXCERPT_CHARS) +
          (git_url
            ? `\nGit installs require library.enable_unsafe_install (scripts/init.js sets it).`
            : `\nCheck the exact registry name with: arduino-cli lib search "${name}"`)
      );
    }
    return textResult({ ok: true, installed: name || git_url, detail: (res.stdout + res.stderr).trim().slice(-1000) });
  }
);

server.registerTool(
  "arduino_update_indexes",
  {
    title: "Update Arduino indexes",
    description: "Run core update-index and lib update-index (refreshes board and library package lists).",
  },
  async () => {
    const core = await runCli(["core", "update-index"], { timeout: INSTALL_TIMEOUT_MS });
    const lib = await runCli(["lib", "update-index"], { timeout: INSTALL_TIMEOUT_MS });
    const ok = core.code === 0 && lib.code === 0;
    if (!ok) {
      return errorResult(
        `Index update failed. core update-index exit ${core.code}, lib update-index exit ${lib.code}.\n` +
          (core.stderr + "\n" + lib.stderr).trim().slice(-STDERR_EXCERPT_CHARS) +
          `\nCheck network access; third-party URLs come from ${CONFIG_FILE} (run scripts/init.js to create it).`
      );
    }
    return textResult({ ok: true });
  }
);

// ---------------------------------------------------------------------------

async function main() {
  cleanupOldTempDirs();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("arduino-mcp server running on stdio");
}

if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}

// Exported for scripts/smoke.js so it exercises the same compile/parse code paths.
module.exports = {
  BOARD_ALIASES,
  BUILD_CACHE_DIR,
  COMPILE_TIMEOUT_MS,
  resolveBoard,
  resolveCli,
  runCli,
  writeSketch,
  parseCompileResult,
};
