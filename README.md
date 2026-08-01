# arduino-mcp

A local stdio MCP server that lets Claude Desktop compile Arduino sketches with [arduino-cli](https://arduino.github.io/arduino-cli/) and get structured compiler diagnostics (errors/warnings with file, line, column) plus flash/RAM usage back. Plain Node.js, no build step, no OAuth.

The entire toolchain (cores, libraries, indexes, build cache) is self-contained under the project's `data\` folder — it never touches a user-level Arduino IDE install.

## Prerequisites

- Windows (paths and process handling are Windows-specific)
- [Node.js](https://nodejs.org/) 18 or newer
- Git

## Install

**1. Clone and install dependencies**

```powershell
git clone https://github.com/Anbus2011/arduino-mcp.git
cd arduino-mcp
npm install
```

**2. Install arduino-cli**

Either:

```powershell
winget install ArduinoSA.CLI
```

or download the Windows 64-bit zip from [arduino.github.io/arduino-cli](https://arduino.github.io/arduino-cli/latest/installation/) and drop `arduino-cli.exe` into `bin\` inside the project. The server looks in `bin\arduino-cli.exe` first, then PATH.

**3. Run one-time setup**

```powershell
node scripts\init.js
```

This creates the self-contained config at `data\arduino-cli.yaml`, adds board manager URLs (esp32, esp8266, teensy), then downloads and installs the cores `arduino:avr`, `arduino:sam`, `esp32:esp32`, `esp8266:esp8266`, `teensy:avr` (teensy is optional — a failure there just warns) and the `Basicmicro` library. **The first run downloads several GB of toolchains and takes a while.** It ends with a summary table of what got installed.

**4. Verify with the smoke test**

```powershell
node scripts\smoke.js
```

Expected: `SMOKE PASS` — it compiles a known-good sketch for `leonardo` (expecting success with memory figures) and a deliberately broken one (expecting a line-numbered error diagnostic).

## Hook up Claude Desktop

Add the server to `%APPDATA%\Claude\claude_desktop_config.json` under `mcpServers` (adjust the path to where you cloned it):

```json
{
  "mcpServers": {
    "arduino": {
      "command": "node",
      "args": ["D:\\mcp-servers\\arduino\\server.js"]
    }
  }
}
```

Then **fully restart Claude Desktop — quit it from the system tray, not just the window**. That's also required after any change to `server.js`.

To verify: in a fresh chat, call `arduino_env_info` (should report the cli version, installed cores, and libraries), then ask Claude to compile a sketch for `a-star` and confirm `ok: true` with flash/RAM figures.

## Running standalone (debugging)

The server speaks MCP over stdio, so it isn't meant to be run by hand — use the MCP Inspector:

```powershell
npx @modelcontextprotocol/inspector node server.js
```

or its CLI mode for quick checks:

```powershell
npx @modelcontextprotocol/inspector --cli node server.js --method tools/list
```

## Tools

| Tool | What it does |
|---|---|
| `arduino_compile` | Compile sketch source against one or more boards; returns per-board diagnostics, flash/RAM usage, duration |
| `arduino_env_info` | arduino-cli version/path, data dir, installed cores + libraries, board alias map |
| `arduino_install_core` | Install a board core (optionally with a board manager URL) |
| `arduino_install_library` | Install a library by registry name or git URL |
| `arduino_update_indexes` | Refresh the core and library indexes |

Boards are given as aliases (`uno`, `leonardo`, `a-star`, `micro`, `mega`, `due`, `esp32`, `esp8266`, `teensy40`) or raw FQBNs — anything containing `:` is passed through as-is.

## Troubleshooting

- **"arduino-cli not found"** — do step 2; the error message names both locations it checked.
- **"Platform ... not installed"** — run `node scripts\init.js` (or call the `arduino_install_core` tool).
- **Missing library** — the compile fails fast with the exact `arduino_install_library` call to fix it; libraries are never auto-installed.
- **Tool changes not showing up in Claude Desktop** — you restarted from the taskbar, not the tray. Fully quit and relaunch.

See [CLAUDE.md](CLAUDE.md) for architecture, conventions, and maintenance details.
