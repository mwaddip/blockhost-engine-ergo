#!/bin/bash
# Ergo engine first-boot hook
#
# The ergo-relay package (separate .deb) provides signing + P2P broadcast.
# It's installed as a dependency and manages its own systemd services.
#
# This hook only needs to ensure the signer_url is set in web3-defaults.yaml.

set -e

LOG_FILE="${LOG_FILE:-/var/log/blockhost-first-boot.log}"

log() { echo "[ergo] $*" | tee -a "$LOG_FILE"; }

# Start ergo-relay signer — needed for tx signing during finalization.
# The relay is bundled in the engine .deb, so its postinst doesn't run separately.
if command -v ergo-relay >/dev/null 2>&1; then
  if ! pgrep -x ergo-relay >/dev/null 2>&1; then
    log "Starting ergo-relay..."
    systemctl enable ergo-relay ergo-peers.timer 2>/dev/null || true
    systemctl start ergo-relay 2>/dev/null || {
      # Fallback: run directly if systemd unit not available
      ergo-relay &
      log "Started ergo-relay (direct, pid $!)"
    }
    sleep 1  # Give relay a moment to bind port
  fi
  # Run peer discovery until at least one peer is found.
  # P2P broadcast needs peers — without them, tx submission falls back to explorer only.
  if command -v ergo-peers >/dev/null 2>&1; then
    PEERS_FILE="/var/lib/blockhost/ergo-peers.json"
    for attempt in 1 2 3; do
      log "Peer discovery attempt $attempt..."
      ergo-peers >> "$LOG_FILE" 2>&1 || true
      if [ -f "$PEERS_FILE" ] && grep -q '"count":[^0]' "$PEERS_FILE" 2>/dev/null; then
        PEER_COUNT=$(python3 -c "import json; print(json.load(open('$PEERS_FILE'))['count'])" 2>/dev/null || echo 0)
        log "Discovered $PEER_COUNT peer(s)"
        break
      fi
      log "No peers found yet, retrying in 5s..."
      sleep 5
    done
    if [ ! -f "$PEERS_FILE" ] || grep -q '"count":0' "$PEERS_FILE" 2>/dev/null; then
      log "WARNING: No peers discovered after 3 attempts — P2P broadcast may fail, explorer fallback will be used"
    fi
  fi
fi

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
