# Privilege Separation

The monitor service runs as the unprivileged `blockhost` user. Operations that require root are delegated to a separate **root agent daemon** (provided by `blockhost-common`) via a Unix socket at `/run/blockhost/root-agent.sock`.

This is chain-agnostic infrastructure shared across all BlockHost engines. The only Ergo-specific detail is how wallet generation works.

## Protocol

Length-prefixed JSON: 4-byte big-endian length + JSON payload (both directions).

- Request: `{"action": "action-name", "params": {...}}`
- Response: `{"ok": true, ...}` or `{"ok": false, "error": "reason"}`

## Client

The TypeScript client (`src/root-agent/client.ts`) provides typed wrappers:

| Action | Description |
|--------|-------------|
| `iptables-open` | Add an ACCEPT rule for a port |
| `iptables-close` | Remove an ACCEPT rule for a port |
| `generate-wallet` | Generate an Ergo wallet, save key to `/etc/blockhost/<name>.key`, update addressbook |
| `addressbook-save` | Write addressbook entries to `/etc/blockhost/addressbook.json` |

## Ergo Wallet Generation

The root agent's `generate-wallet` action invokes `bhcrypt generate-keypair <outfile>` as a subprocess:

1. Generates a random secp256k1 private key (32 bytes)
2. Writes raw hex to `/etc/blockhost/<name>.key` (chmod 600, `blockhost` group)
3. Derives the P2PK Ergo address from the public key
4. Adds the Base58 address to `addressbook.json`

For the deployer wallet (generated via the wizard), `bhcrypt generate-mnemonic` is used instead — it generates a BIP39 mnemonic, derives the key via BIP32 EIP-3 path, and outputs the raw hex private key. The mnemonic is shown to the operator for backup but only the derived key is stored on disk.

## What Does NOT Go Through the Root Agent

- Reading keyfiles and `addressbook.json` — works via group permission (`blockhost` group, mode 0640)
- ECIES decryption — `blockhost` user can read `server.key` via group permission
- VM provisioning scripts — provisioner runs as `blockhost`
- Process checks (`pgrep`) — no privilege needed
- Explorer API queries — no privilege needed

## Systemd

The monitor service declares a dependency on `blockhost-root-agent.service` and runs with `NoNewPrivileges=true` and `ProtectSystem=strict`. See `examples/blockhost-monitor.service`.
