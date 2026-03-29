# Engine Manifest

`engine.json` declares engine identity, wizard plugin module, finalization steps, and chain-specific `constraints` used by consumers (installer, admin panel) for input validation and UI rendering.

## Schema

```json
{
  "name": "ergo",
  "version": "0.1.0",
  "display_name": "Ergo",
  "accent_color": "#ff5e18",
  "setup": {
    "first_boot_hook": "/usr/share/blockhost/engine-hooks/first-boot.sh",
    "wizard_module": "blockhost.engine_ergo.wizard",
    "finalization_steps": ["wallet", "contracts", "chain_config"],
    "post_finalization_steps": ["mint_nft", "plan", "revenue_share"]
  },
  "config_keys": {
    "session_key": "blockchain"
  },
  "constraints": { ... }
}
```

## Constraints

| Field | Description | Ergo value |
|-------|-------------|------------|
| `address_pattern` | Regex for valid addresses | `^[39][1-9A-HJ-NP-Za-km-z]{50}$` |
| `native_token` | Native currency keyword for CLIs | `erg` |
| `native_token_label` | Display label for native currency | `ERG` |
| `token_pattern` | Regex for valid token identifiers | `^[0-9a-fA-F]{64}$` |
| `address_placeholder` | Placeholder for address inputs | `9f5Q...` |

Address pattern matches:
- Mainnet P2PK addresses (`9...`, 51 chars)
- Testnet P2PK addresses (`3...`, 51 chars)
- Base58 character set: `[1-9A-HJ-NP-Za-km-z]` (excludes 0, O, I, l)

Token pattern matches:
- 64-character hex strings (Ergo token IDs = first input box ID of minting tx)

All patterns are anchored regexes. If `constraints` is absent, consumers skip format validation and let CLIs reject invalid input.

## Theming

The `accent_color` field (`#ff5e18`, Ergo orange) is used as the primary brand color by the signup page generator and signing page template (as the `--primary` CSS variable).

## Installer Integration

The installer discovers `engine.json` at `/usr/share/blockhost/engine.json`. It reads:
- `wizard_module` — Python module to load as the blockchain configuration wizard page
- `finalization_steps` — Steps run before VMs can be provisioned
- `post_finalization_steps` — Steps run after finalization (plan creation, NFT minting, revenue share setup)
- `constraints` — Used for address/token format validation in the installer UI and admin panel
