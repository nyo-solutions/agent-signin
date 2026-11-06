#!/usr/bin/env python3
"""Idempotently register the bitwarden MCP server in Claude Desktop and Claude Code.
Merges into existing config without touching other servers; backs up first."""
import json, os, shutil, time
HOME = os.path.expanduser("~")
LAUNCHER = f"{HOME}/projects/agent-vault/bin/bitwarden-mcp"
stamp = time.strftime("%Y%m%d-%H%M%S")

def backup(p):
    if os.path.exists(p):
        shutil.copy2(p, f"{p}.bak-{stamp}")

# Claude Desktop (JSON)
cd = f"{HOME}/Library/Application Support/Claude/claude_desktop_config.json"
cfg = json.load(open(cd)) if os.path.exists(cd) else {}
want = {"command": LAUNCHER, "args": []}
if cfg.get("mcpServers", {}).get("bitwarden") != want:
    backup(cd)
    cfg.setdefault("mcpServers", {})["bitwarden"] = want
    os.makedirs(os.path.dirname(cd), exist_ok=True)
    with open(cd, "w") as f: json.dump(cfg, f, indent=2)
    print("Claude Desktop: bitwarden MCP server configured.")
else:
    print("Claude Desktop: already configured.")

# Claude Code (Code tab / CLI), user scope - via the CLI, which handles ~/.claude.json safely.
import glob, subprocess
cands = sorted(glob.glob(f"{HOME}/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude"),
               key=os.path.getmtime) or [shutil.which("claude")]
cli = cands[-1] if cands and cands[-1] else None
if not cli:
    print("Claude Code: CLI not found; skipped.")
else:
    try:
        cur = json.load(open(f"{HOME}/.claude.json")).get("mcpServers", {}).get("bitwarden", {})
    except Exception:
        cur = {}
    if cur.get("command") == LAUNCHER:
        print("Claude Code: already configured.")
    else:
        subprocess.run([cli, "mcp", "remove", "--scope", "user", "bitwarden"], capture_output=True)
        r = subprocess.run([cli, "mcp", "add", "--scope", "user", "bitwarden", "--", LAUNCHER], capture_output=True, text=True)
        print("Claude Code: bitwarden MCP server configured." if r.returncode == 0 else f"Claude Code: add failed: {r.stderr.strip()}")
