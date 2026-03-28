#!/bin/bash
# Ergo engine first-boot hook
#
# Installs the ergo-signer service for transaction signing.
# The ergo-signer binary is shipped in the .deb — no downloads needed.
#
# The Ergo node (for UTXO queries and tx submission) is configured via
# blockchain.node_url in web3-defaults.yaml. The operator can:
#   - Run a local Ergo node (install separately, recommended)
#   - Point to a remote node in their infrastructure
#   - Use a public node endpoint
#
# The engine does not install or manage the Ergo node itself — that's
# infrastructure, not engine responsibility. The engine only needs a
# URL that answers /blockchain/box/* and /transactions endpoints.

set -e

LOG_FILE="${LOG_FILE:-/var/log/blockhost-first-boot.log}"

log() { echo "[ergo] $*" | tee -a "$LOG_FILE"; }

# ── Enable and start ergo-signer ────────────────────────────────────
# The binary and systemd unit are installed by the .deb package at:
#   /usr/share/blockhost/ergo-signer
#   /lib/systemd/system/ergo-signer.service

if [ -f /usr/share/blockhost/ergo-signer ]; then
  systemctl daemon-reload
  systemctl enable ergo-signer
  systemctl start ergo-signer
  log "ergo-signer service started on port 9064"
else
  log "WARNING: ergo-signer binary not found at /usr/share/blockhost/ergo-signer"
fi

# ── Ensure signer_url is in web3-defaults ───────────────────────────
if [ -f /etc/blockhost/web3-defaults.yaml ]; then
  if ! grep -q "signer_url" /etc/blockhost/web3-defaults.yaml; then
    python3 -c "
import yaml
with open('/etc/blockhost/web3-defaults.yaml') as f:
    d = yaml.safe_load(f) or {}
bc = d.setdefault('blockchain', {})
bc.setdefault('signer_url', 'http://127.0.0.1:9064')
with open('/etc/blockhost/web3-defaults.yaml', 'w') as f:
    yaml.dump(d, f, default_flow_style=False)
" >> "$LOG_FILE" 2>&1
    log "Added signer_url to web3-defaults.yaml"
  fi
fi

log "First-boot hook complete"
exit 0
