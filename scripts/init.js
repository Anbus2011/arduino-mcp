#!/usr/bin/env node
// One-time environment setup for arduino-mcp. Run by hand after `npm install`:
//   node scripts\init.js
// Creates the self-contained arduino-cli config/data dir, installs cores and the
// Basicmicro library. First run downloads toolchains and takes several minutes.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const CONFIG_FILE = path.join(DATA_DIR, "arduino-cli.yaml");

const BOARD_MANAGER_URLS = [
  "https://espressif.github.io/arduino-esp32/package_esp32_index.json",
  "https://arduino.esp8266.com/stable/package_esp8266com_index.json",
  "https://www.pjrc.com/teensy/package_teensy_index.json",
];

const CORES = [
  { id: "arduino:avr", optional: false },
  { id: "arduino:sam", optional: false },
  { id: "esp32:esp32", optional: false },
  { id: "esp8266:esp8266", optional: false },
  { id: "teensy:avr", optional: true }, // teensy tooling is flaky on some setups — warn and continue
];

function resolveCli() {
  const bundled = path.join(PROJECT_ROOT, "bin", "arduino-cli.exe");
  if (fs.existsSync(bundled)) return bundled;
  const probe = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["arduino-cli"], {
    encoding: "utf8",
  });
  if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim().split(/\r?\n/)[0];
  console.error(
    `ERROR: arduino-cli not found (looked for ${bundled} and PATH).\n` +
      `Fix: winget install ArduinoSA.CLI, or drop arduino-cli.exe into ${path.join(PROJECT_ROOT, "bin")}\\`
  );
  process.exit(1);
}

const CLI = resolveCli();

function run(args, { allowFail = false, timeoutMs = 15 * 60 * 1000 } = {}) {
  const display = `arduino-cli ${args.join(" ")}`;
  console.log(`\n> ${display}`);
  const res = spawnSync(CLI, ["--config-file", CONFIG_FILE, ...args], {
    stdio: "inherit",
    timeout: timeoutMs,
    env: {
      ...process.env,
      ARDUINO_DIRECTORIES_DATA: DATA_DIR,
      ARDUINO_DIRECTORIES_DOWNLOADS: path.join(DATA_DIR, "downloads"),
      ARDUINO_DIRECTORIES_USER: path.join(DATA_DIR, "user"),
    },
  });
  if (res.status !== 0 && !allowFail) {
    console.error(`FAILED (exit ${res.status}): ${display}`);
    process.exit(1);
  }
  return res.status === 0;
}

function runJson(args) {
  const res = spawnSync(CLI, ["--config-file", CONFIG_FILE, ...args, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      ARDUINO_DIRECTORIES_DATA: DATA_DIR,
      ARDUINO_DIRECTORIES_DOWNLOADS: path.join(DATA_DIR, "downloads"),
      ARDUINO_DIRECTORIES_USER: path.join(DATA_DIR, "user"),
    },
  });
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

console.log(`arduino-mcp init\n  cli:    ${CLI}\n  data:   ${DATA_DIR}\n  config: ${CONFIG_FILE}`);

// 1. Config: init into the project data dir, add board manager URLs, enable unsafe (git) lib installs.
fs.mkdirSync(DATA_DIR, { recursive: true });
run(["config", "init", "--dest-file", CONFIG_FILE, "--overwrite"]);
run(["config", "set", "board_manager.additional_urls", ...BOARD_MANAGER_URLS]);
run(["config", "set", "library.enable_unsafe_install", "true"]);
run(["config", "set", "directories.data", DATA_DIR]);
run(["config", "set", "directories.downloads", path.join(DATA_DIR, "downloads")]);
run(["config", "set", "directories.user", path.join(DATA_DIR, "user")]);

// 2. Cores.
run(["core", "update-index"]);
const coreResults = [];
for (const core of CORES) {
  const ok = run(["core", "install", core.id], { allowFail: core.optional });
  if (!ok && core.optional) {
    console.warn(`WARNING: optional core ${core.id} failed to install — continuing without it.`);
  }
  coreResults.push({ id: core.id, ok });
}

// 3. Libraries.
run(["lib", "update-index"]);
const libOk = run(["lib", "install", "Basicmicro"], { allowFail: true });
if (!libOk) {
  console.warn(
    'WARNING: lib install Basicmicro failed. If it is not in the registry, install from git:\n' +
      '  arduino-cli --config-file "' + CONFIG_FILE + '" lib install --git-url <repo-url>'
  );
}

// 4. Summary table.
console.log("\n=== arduino-mcp init summary ===");
const installedCores = runJson(["core", "list"]);
const corePad = 18;
for (const { id, ok } of coreResults) {
  const found = installedCores && (installedCores.platforms || []).find((p) => p.id === id);
  const version = found ? found.installed_version || found.installed || "?" : "-";
  console.log(`  core ${id.padEnd(corePad)} ${ok ? "OK " : "FAIL"}  ${version}`);
}
const libs = runJson(["lib", "list"]);
for (const entry of (libs && libs.installed_libraries) || []) {
  console.log(`  lib  ${String(entry.library?.name).padEnd(corePad)} OK   ${entry.library?.version || "?"}`);
}
console.log("\nNext: node scripts\\smoke.js");
