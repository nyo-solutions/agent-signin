#!/bin/bash
# Rebuilding changes the binary's signature: run `vault-touchid store` again afterwards.
set -euo pipefail
cd "$(dirname "$0")"
swiftc -O main.swift -o ../bin/vault-touchid
codesign -s - -f --identifier solutions.nyo.agent-vault.touchid ../bin/vault-touchid
echo "built ../bin/vault-touchid"
