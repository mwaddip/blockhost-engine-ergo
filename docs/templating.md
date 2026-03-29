# Page Templating

The signing and signup pages are split into replaceable HTML/CSS templates and engine-owned JS bundles. Anyone forking the engine can drop in their own HTML/CSS without touching the wallet/chain JavaScript.

## Architecture

```
template (HTML/CSS)     — layout, branding, copy, styles
engine bundle (JS)      — EIP-12 wallet connection, signing, explorer queries
generator (Python)      — injects config variables, combines template + bundle -> output
```

The template never contains wallet or chain logic. The bundle never contains layout or styling. The generator is the glue.

## Files

**Signing Page** (served by libpam-web3-ergo auth-svc)

| File | Role |
|------|------|
| `signing-page/index.html` | HTML/CSS template + engine JS |
| `signing-page/engine.js` | EIP-12 wallet + Schnorr signing logic |

Note: the signing page is part of the `libpam-web3-ergo` package, not the engine. It is included here for completeness.

**Signup Page**

| File | Role |
|------|------|
| `scripts/signup-template.html` | Replaceable HTML/CSS template |
| `scripts/signup-engine.js` | Engine-owned EIP-12 wallet + subscription + ECIES logic |
| `scripts/generate-signup-page` | Generator script (Python) |

## Template Variables

Injected as `{{VARIABLE}}` placeholders by the generator.

| Variable | Type | Description |
|----------|------|-------------|
| `PAGE_TITLE` | string | Page heading text |
| `PRIMARY_COLOR` | CSS color | Accent color (from `engine.json` -> `accent_color`, default `#ff5e18`) |
| `PUBLIC_SECRET` | string | Challenge message prefix the user signs |
| `SERVER_PUBLIC_KEY` | hex string | secp256k1 public key for ECIES encryption of user data |
| `DEPLOYER_ADDRESS` | Base58 | Server address (for plan box queries) |
| `DEPLOYER_ERGO_TREE` | hex string | Server's ErgoTree (for plan box filtering) |
| `SUBSCRIPTION_ERGO_TREE` | hex string | Guard script ErgoTree (for subscription creation) |
| `EXPLORER_URL` | URL | Explorer API base URL |
| `NETWORK` | string | `mainnet` or `testnet` |

The accent color is applied via a CSS variable in the template's `<style>` block:

```css
:root {
  --primary: {{PRIMARY_COLOR}};
}
```

## CONFIG Object

The template includes a `<script>` block with the CONFIG object, followed by the engine bundle:

```html
<script>
var CONFIG = {
  publicSecret:            "{{PUBLIC_SECRET}}",
  serverPublicKey:         "{{SERVER_PUBLIC_KEY}}",
  deployerAddress:         "{{DEPLOYER_ADDRESS}}",
  deployerErgoTree:        "{{DEPLOYER_ERGO_TREE}}",
  subscriptionErgoTree:    "{{SUBSCRIPTION_ERGO_TREE}}",
  explorerUrl:             "{{EXPLORER_URL}}",
  network:                 "{{NETWORK}}"
};
</script>
<script src="signup-engine.js"></script>
```

## Required DOM Elements

The engine JS finds elements by `id`. Templates must include all required elements. See the signup-template.html source for the canonical list.

## CSS Class Contract

The engine JS adds/removes these classes. The template defines their appearance.

| Class | Applied to | Meaning |
|-------|-----------|---------|
| `hidden` | any step container | Step not yet active |
| `active` | step container | Currently active step |
| `completed` | step container | Step finished |
| `disabled` | button | Button not yet clickable |
| `loading` | button | Operation in progress |
| `error` | `#status-message` | Error state |
| `success` | `#status-message` | Success state |

## Generating the Signup Page

```bash
blockhost-generate-signup --output /var/www/signup.html
blockhost-generate-signup --config /etc/blockhost/blockhost.yaml \
                          --web3-config /etc/blockhost/web3-defaults.yaml \
                          --output /var/www/html/signup.html
blockhost-generate-signup --serve 8080   # Generate then serve on port 8080 for testing
```

The generator reads `blockhost.yaml` + `web3-defaults.yaml`, reads `accent_color` from `engine.json`, replaces `{{VARIABLE}}` placeholders in the template, and copies `signup-engine.js` alongside the output HTML.
