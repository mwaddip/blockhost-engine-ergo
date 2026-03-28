#!/bin/bash
# Ergo engine first-boot hook
#
# The ergo-signer package (separate .deb) provides signing + P2P broadcast.
# It's installed as a dependency and manages its own systemd services.
#
# This hook only needs to ensure the signer_url is set in web3-defaults.yaml.

set -e

LOG_FILE="${LOG_FILE:-/var/log/blockhost-first-boot.log}"

log() { echo "[ergo] $*" | tee -a "$LOG_FILE"; }

# Ensure signer_url is in web3-defaults
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
