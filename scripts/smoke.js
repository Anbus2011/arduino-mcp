#!/usr/bin/env node
// Post-deploy smoke test for arduino-mcp — no MCP client needed:
//   node scripts\smoke.js
// Compiles a known-good Basicmicro sketch for leonardo (expect ok=true) and the
// same sketch with the include removed (expect ok=false with a line-numbered
// error diagnostic). Exits non-zero on any mismatch.

const { resolveBoard, runCli, writeSketch, parseCompileResult, BUILD_CACHE_DIR, COMPILE_TIMEOUT_MS } = require("../server.js");

const GOOD_SKETCH = `#include <Basicmicro.h>

Basicmicro controller(&Serial1, 10000);

void setup() {
  controller.begin(38400);
}

void loop() {
  controller.DutyM1(128, 32767);
}
`;

const BAD_SKETCH = GOOD_SKETCH.replace(/#include <Basicmicro\.h>\r?\n/, "");

async function compile(code) {
  const { board, fqbn } = resolveBoard("leonardo");
  const sketchDir = writeSketch(code, fqbn, "sketch.ino");
  const res = await runCli(
    ["compile", "--fqbn", fqbn, "--json", "--warnings", "all", "--build-cache-path", BUILD_CACHE_DIR, sketchDir],
    { timeout: COMPILE_TIMEOUT_MS }
  );
  return parseCompileResult(board, fqbn, res);
}

let failures = 0;
function check(label, cond, detail) {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(`        ${detail}`);
  }
}

(async () => {
  console.log("arduino-mcp smoke test (board: leonardo)\n");

  console.log("[1/2] known-good Basicmicro sketch:");
  const good = await compile(GOOD_SKETCH);
  check("compiles clean (ok=true)", good.ok === true, JSON.stringify(good.diagnostics) + (good.raw_stderr_excerpt || ""));
  check("reports flash usage", good.memory && typeof good.memory.flash_bytes === "number", JSON.stringify(good.memory));
  check("reports RAM usage", good.memory && typeof good.memory.ram_bytes === "number", JSON.stringify(good.memory));

  console.log("\n[2/2] same sketch without the include:");
  const bad = await compile(BAD_SKETCH);
  const lineNumberedErrors = bad.diagnostics.filter((d) => d.severity === "error" && Number.isFinite(d.line));
  check("fails to compile (ok=false)", bad.ok === false);
  check(
    "has >=1 error diagnostic with a line number",
    lineNumberedErrors.length >= 1,
    JSON.stringify(bad.diagnostics)
  );

  console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures} check(s) failed)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("\nSMOKE FAIL (unexpected error):", err.message);
  process.exit(1);
});
