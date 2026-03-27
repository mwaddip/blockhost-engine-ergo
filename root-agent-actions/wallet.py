"""Root agent action: generate Ergo wallet."""

import subprocess
import json
import os
import re

ACTIONS = {}


def generate_wallet(params):
    """Generate a new Ergo wallet (secp256k1 keypair + Base58 address)."""
    name = params.get("name")
    if not name:
        return {"ok": False, "error": "missing name parameter"}

    # Security: validate name
    if not re.match(r'^[a-z0-9-]{1,32}$', name):
        return {"ok": False, "error": f"invalid wallet name: {name}"}

    # Deny reserved names
    DENY_NAMES = frozenset({'admin', 'server', 'dev', 'broker'})
    if name in DENY_NAMES:
        return {"ok": False, "error": f"reserved name: {name}"}

    key_path = f"/etc/blockhost/{name}.key"
    if os.path.exists(key_path):
        return {"ok": False, "error": f"key already exists: {key_path}"}

    # Generate keypair using bhcrypt generate-keypair
    # bhcrypt writes the private key to the file and prints the address to stdout
    try:
        result = subprocess.run(
            ["npx", "tsx", "/usr/share/blockhost/src/bhcrypt.ts",
             "generate-keypair", key_path],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            return {"ok": False, "error": f"bhcrypt failed: {result.stderr}"}

        address = result.stdout.strip()
        if not address:
            return {"ok": False, "error": "bhcrypt returned empty address"}

        # Set key file permissions (root:blockhost 0640)
        import grp
        try:
            gid = grp.getgrnam("blockhost").gr_gid
            os.chown(key_path, 0, gid)
        except KeyError:
            pass  # blockhost group may not exist in dev
        os.chmod(key_path, 0o640)

        return {"ok": True, "address": address}
    except Exception as e:
        return {"ok": False, "error": str(e)}


ACTIONS["generate-wallet"] = generate_wallet
