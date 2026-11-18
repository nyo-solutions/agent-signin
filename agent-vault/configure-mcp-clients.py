#!/usr/bin/env python3
"""Idempotently register the agent-autofill MCP server in Claude Desktop and Claude Code,
and remove the old `bitwarden` MCP server (it returned plaintext passwords to agents).
Merges into existing config without touching other servers; backs up first."""
import glob, json, os, shutil, subprocess, time
HOME = os.path.expanduser("~")
NAME = "agent-autofill"
LAUNCHER = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "agent-autofill", "bin", "agent-autofill-mcp"))
RETIRED = ["bitwarden"]
stamp = time.strftime("%Y%m%d-%H%M%S")

def backup(p):
    if os.path.exists(p):
        shutil.copy2(p, f"{p}.bak-{stamp}")

if not os.path.exists(LAUNCHER):
    print(f"agent-autofill not found at {LAUNCHER}; nothing configured.")
    raise SystemExit(0)

# Claude Desktop (JSON)
cd = f"{HOME}/Library/Application Support/Claude/claude_desktop_config.json"
cfg = json.load(open(cd)) if os.path.exists(cd) else {}
servers = cfg.setdefault("mcpServers", {})
want = {"command": LAUNCHER, "args": []}
if servers.get(NAME) != want or any(r in servers for r in RETIRED):
    backup(cd)
    for r in RETIRED:
        servers.pop(r, None)
    servers[NAME] = want
    os.makedirs(os.path.dirname(cd), exist_ok=True)
    with open(cd, "w") as f: json.dump(cfg, f, indent=2)
    print("Claude Desktop: agent-autofill MCP server configured.")
else:
    print("Claude Desktop: already configured.")

# Claude Code (Code tab / CLI), user scope - via the CLI, which handles ~/.claude.json safely.
cands = sorted(glob.glob(f"{HOME}/Library/Application Support/Claude/claude-code/*/*/claude.app/Contents/MacOS/claude"),
               key=os.path.getmtime) or [shutil.which("claude")]
cli = cands[-1] if cands and cands[-1] else None
if not cli:
    print("Claude Code: CLI not found; skipped.")
else:
    try:
        cur = json.load(open(f"{HOME}/.claude.json")).get("mcpServers", {})
    except Exception:
        cur = {}
    for r in RETIRED:
        if r in cur:
            subprocess.run([cli, "mcp", "remove", "--scope", "user", r], capture_output=True)
            print(f"Claude Code: removed retired '{r}' MCP server.")
    if cur.get(NAME, {}).get("command") == LAUNCHER:
        print("Claude Code: already configured.")
    else:
        subprocess.run([cli, "mcp", "remove", "--scope", "user", NAME], capture_output=True)
        r = subprocess.run([cli, "mcp", "add", "--scope", "user", NAME, "--", LAUNCHER], capture_output=True, text=True)
        print("Claude Code: agent-autofill MCP server configured." if r.returncode == 0 else f"Claude Code: add failed: {r.stderr.strip()}")
