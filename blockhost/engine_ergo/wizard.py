"""
Ergo engine wizard plugin for BlockHost installer.

Provides:
- Flask Blueprint with /wizard/ergo route and blockchain API routes
- Pre-provisioner finalization steps: wallet, contracts, chain_config
- Post-nginx finalization steps: mint_nft, plan, revenue_share
- Summary data and template for the summary page
"""

import grp
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

from flask import (
    Blueprint,
    current_app,
    jsonify,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

blueprint = Blueprint(
    "engine_ergo",
    __name__,
    template_folder="templates",
    static_folder="static",
    static_url_path="/engine-ergo/static",
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

NETWORK_NAMES = {
    "mainnet": "Ergo Mainnet",
    "testnet": "Ergo Testnet",
}

CONFIG_DIR = Path("/etc/blockhost")
TESTING_MODE_FILE = CONFIG_DIR / ".testing-mode"

# Ergo block interval is ~2 minutes; ~720 blocks/day
BLOCKS_PER_DAY = 720

# Testing mode: 3 blocks per interval (~6 minutes) instead of 1 day
TESTING_INTERVAL_BLOCKS = 3

# Ergo Base58-encoded address: starts with 9 (P2PK mainnet) or 3 (P2S mainnet)
# Testnet addresses start with different prefixes but share the same Base58 charset.
ERGO_ADDRESS_RE = re.compile(
    r"^[1-9A-HJ-NP-Za-km-z]{40,120}$"
)

# ErgoTree hex: even-length hex string, at least 2 bytes
ERGO_TREE_RE = re.compile(r"^[0-9a-fA-F]{4,}$")

# Token ID: 32-byte hex (64 hex chars) -- corresponds to a box ID
TOKEN_ID_RE = re.compile(r"^[0-9a-fA-F]{64}$")


def validate_ergo_address(address: str) -> bool:
    """Validate an Ergo Base58-encoded address."""
    if not address or not isinstance(address, str):
        return False
    addr = address.strip()
    if not ERGO_ADDRESS_RE.match(addr):
        return False
    # Additional heuristic: mainnet P2PK starts with '9', P2S starts with various
    # Testnet addresses start with '3' typically
    return True


# Alias for installer discovery (app.py calls getattr(module, 'validate_address'))
validate_address = validate_ergo_address


def validate_ergo_tree(tree: str) -> bool:
    """Validate an ErgoTree hex string."""
    if not tree or not isinstance(tree, str):
        return False
    return bool(ERGO_TREE_RE.match(tree.strip()))


# ---------------------------------------------------------------------------
# Optional exports: signature / encryption helpers
# ---------------------------------------------------------------------------


def validate_signature(sig: str) -> bool:
    """Validate hex key material (even-length hex, at least 8 chars).

    Accepts hex-encoded publicSecret+password string from the wizard.
    """
    if not sig or not isinstance(sig, str):
        return False
    sig = sig.strip()
    return bool(re.match(r"^[0-9a-fA-F]{8,}$", sig))


def _wait_for_tx_confirmation(
    tx_id: str,
    blockchain: dict,
    timeout: int = 600,
    poll_interval: int = 10,
) -> tuple[bool, Optional[str]]:
    """Poll the explorer until a transaction is confirmed (has numConfirmations >= 1).

    Returns (True, None) on confirmation, (False, reason) on timeout or error.
    """
    import time
    import urllib.request
    import urllib.error

    explorer = _explorer_url(blockchain)
    url = f"{explorer}/api/v1/transactions/{tx_id}"

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read())
                confirmations = data.get("numConfirmations", 0)
                if isinstance(confirmations, int) and confirmations >= 1:
                    return True, None
        except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError):
            pass  # Explorer hasn't indexed it yet or is temporarily unavailable
        time.sleep(poll_interval)

    return False, f"Transaction {tx_id} not confirmed within {timeout}s"


def decrypt_config(sig: str, ciphertext: str) -> dict:
    """Decrypt config backup using SHAKE256-derived key from signature.

    The signature is used as key material; SHAKE256 derives a 32-byte
    symmetric key, then AES-256-GCM or XOR cipher decrypts the payload.
    """
    if not sig or not ciphertext:
        raise ValueError("Signature and ciphertext are required")

    try:
        result = subprocess.run(
            ["bhcrypt", "decrypt-symmetric", sig.strip(), ciphertext.strip()],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise ValueError(f"Decryption failed: {result.stderr.strip()}")
        return json.loads(result.stdout.strip())
    except FileNotFoundError:
        raise ValueError("bhcrypt not found")
    except json.JSONDecodeError:
        raise ValueError("Decrypted data is not valid JSON")


def encrypt_config(sig: str, plaintext: str) -> str:
    """Encrypt config for backup download using SHAKE256-derived key."""
    if not sig or not plaintext:
        raise ValueError("Signature and plaintext are required")

    try:
        result = subprocess.run(
            ["bhcrypt", "encrypt-symmetric", sig.strip(), plaintext.strip()],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode != 0:
            raise ValueError(f"Encryption failed: {result.stderr.strip()}")
        output = result.stdout.strip()
        if output.startswith("0x"):
            output = output[2:]
        return output
    except FileNotFoundError:
        raise ValueError("bhcrypt not found")


# ---------------------------------------------------------------------------
# Wizard Route
# ---------------------------------------------------------------------------


@blueprint.route("/wizard/ergo", methods=["GET", "POST"])
def wizard_ergo():
    """Ergo blockchain configuration step."""
    if request.method == "POST":
        network = request.form.get("network", "testnet").strip()
        node_url = request.form.get("node_url", "").strip()
        explorer_url = request.form.get("explorer_url", "").strip()
        wallet_mode = request.form.get("wallet_mode", "generate")
        deployer_mnemonic = request.form.get("deployer_mnemonic", "").strip()
        deployer_address = request.form.get("deployer_address", "").strip()
        contract_mode = request.form.get("contract_mode", "deploy")
        subscription_ergo_tree = request.form.get(
            "subscription_ergo_tree", ""
        ).strip()
        reference_ergo_tree = request.form.get(
            "reference_ergo_tree", ""
        ).strip()
        plan_name = request.form.get("plan_name", "Basic VM").strip()
        try:
            plan_price_cents = int(request.form.get("plan_price_cents", 50))
        except (ValueError, TypeError):
            plan_price_cents = 50
        revenue_share_enabled = request.form.get("revenue_share_enabled") == "on"
        try:
            revenue_share_percent = float(
                request.form.get("revenue_share_percent", 1.0)
            )
        except (ValueError, TypeError):
            revenue_share_percent = 1.0
        revenue_share_dev = request.form.get("revenue_share_dev") == "on"
        revenue_share_broker = request.form.get("revenue_share_broker") == "on"

        session["blockchain"] = {
            "network": network,
            "node_url": node_url,
            "explorer_url": explorer_url,
            "wallet_mode": wallet_mode,
            "deployer_mnemonic": deployer_mnemonic,
            "deployer_address": deployer_address,
            "contract_mode": contract_mode,
            "subscription_ergo_tree": subscription_ergo_tree,
            "reference_ergo_tree": reference_ergo_tree,
            "plan_name": plan_name,
            "plan_price_cents": plan_price_cents,
            "revenue_share_enabled": revenue_share_enabled,
            "revenue_share_percent": revenue_share_percent,
            "revenue_share_dev": revenue_share_dev,
            "revenue_share_broker": revenue_share_broker,
        }

        # Navigate to next wizard step
        try:
            nav = current_app.jinja_env.globals.get("wizard_nav")
            if nav:
                next_info = nav("ergo")
                if next_info and next_info.get("next"):
                    return redirect(url_for(next_info["next"]))
        except Exception:
            pass
        return redirect(url_for("wizard_ipv6"))

    return render_template(
        "engine_ergo/blockchain.html",
        network_names=NETWORK_NAMES,
        blockchain=session.get("blockchain", {}),
    )


# ---------------------------------------------------------------------------
# API Routes
# ---------------------------------------------------------------------------


@blueprint.route("/api/blockchain/generate-wallet", methods=["POST"])
def api_generate_wallet():
    """Generate a new Ergo keypair.

    Uses bhcrypt generate-mnemonic CLI (bundled with engine package).
    Returns mnemonic phrase and Ergo Base58 address.
    """
    blockchain = session.get("blockchain", {})
    network = blockchain.get("network", "testnet")

    try:
        result = subprocess.run(
            ["bhcrypt", "generate-mnemonic", network],
            capture_output=True,
            text=True,
            timeout=30,
        )

        if result.returncode != 0:
            return jsonify(
                {"error": f"Wallet generation failed: {result.stderr.strip()}"}
            ), 500

        data = json.loads(result.stdout.strip())
        return jsonify({
            "mnemonic": data["mnemonic"],
            "address": data["address"],
        })
    except json.JSONDecodeError:
        return jsonify({"error": "Could not parse wallet output"}), 500
    except FileNotFoundError:
        return jsonify(
            {"error": "bhcrypt not found — is blockhost-engine-ergo installed?"}
        ), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Wallet generation timed out"}), 500


@blueprint.route("/api/blockchain/validate-mnemonic", methods=["POST"])
def api_validate_mnemonic():
    """Validate a mnemonic phrase and return its Ergo address."""
    data = request.get_json()
    mnemonic_phrase = (data or {}).get("mnemonic", "").strip()

    if not mnemonic_phrase:
        return jsonify({"error": "Mnemonic phrase required"}), 400

    words = mnemonic_phrase.split()
    if len(words) not in (12, 15, 18, 21, 24):
        return jsonify(
            {"error": f"Invalid word count ({len(words)}), expected 12-24"}
        ), 400

    # BIP39: only lowercase words and spaces
    if not re.match(r"^[a-z ]+$", mnemonic_phrase):
        return jsonify({"error": "Mnemonic must contain only lowercase words"}), 400

    blockchain = session.get("blockchain", {})
    network = blockchain.get("network", "testnet")

    try:
        result = subprocess.run(
            ["bhcrypt", "validate-mnemonic", network],
            capture_output=True,
            text=True,
            timeout=30,
            env={**os.environ, "MNEMONIC": mnemonic_phrase},
        )

        if result.returncode == 0 and result.stdout.strip():
            addr_data = json.loads(result.stdout.strip())
            return jsonify({
                "address": addr_data["address"],
                "mnemonic": mnemonic_phrase,
            })
        else:
            return jsonify(
                {"error": result.stderr.strip() or "Invalid mnemonic"}
            ), 400
    except FileNotFoundError:
        return jsonify(
            {"error": "bhcrypt not found — is blockhost-engine-ergo installed?"}
        ), 500
    except subprocess.TimeoutExpired:
        return jsonify({"error": "Validation timed out"}), 500


@blueprint.route("/api/blockchain/balance", methods=["POST"])
def api_balance():
    """Query ERG balance for an address via the Ergo node or Explorer API."""
    data = request.get_json()
    address = (data or {}).get("address", "").strip()
    if not address:
        return jsonify({"error": "Address required"}), 400

    blockchain = session.get("blockchain", {})
    explorer = _explorer_url(blockchain)

    try:
        import urllib.request

        req = urllib.request.Request(
            f"{explorer}/api/v1/addresses/{address}/balance/total",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            # Explorer returns { confirmed: { nanoErgs: N, ... }, ... }
            if result and "confirmed" in result:
                nano = result["confirmed"].get("nanoErgs", 0)
                return jsonify({"balance": str(nano)})
            return jsonify({"balance": "0"})
    except Exception as e:
        return jsonify({"balance": "0", "error": str(e)})


@blueprint.route("/api/blockchain/height", methods=["GET"])
def api_height():
    """Get current blockchain height via the Ergo Explorer API."""
    blockchain = session.get("blockchain", {})
    node = _node_url(blockchain)

    try:
        import urllib.request

        req = urllib.request.Request(
            f"{node}/info",
            headers={"Accept": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            result = json.loads(resp.read())
            if result and "fullHeight" in result:
                return jsonify({"height": result["fullHeight"]})
            return jsonify({"error": "No height data"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _node_url(blockchain: dict) -> str:
    """Resolve the Ergo node URL from session config or defaults."""
    custom = blockchain.get("node_url", "")
    if custom:
        return custom.rstrip("/")
    network = blockchain.get("network", "testnet")
    if network == "mainnet":
        return "http://localhost:9053"
    return "http://localhost:9052"


def _explorer_url(blockchain: dict) -> str:
    """Resolve the Ergo Explorer URL from session config or defaults."""
    custom = blockchain.get("explorer_url", "")
    if custom:
        return custom.rstrip("/")
    # Check environment or existing config
    env_url = os.environ.get("ERGO_EXPLORER_URL", "")
    if env_url:
        return env_url.rstrip("/")
    cfg_path = CONFIG_DIR / "web3-defaults.yaml"
    if cfg_path.exists():
        try:
            import yaml as _y
            _raw = _y.safe_load(cfg_path.read_text()) or {}
            saved = (_raw.get("blockchain") or {}).get("explorer_url", "")
            if saved:
                return saved.rstrip("/")
        except Exception:
            pass
    network = blockchain.get("network", "testnet")
    if network == "mainnet":
        return "https://api.ergoplatform.com"
    return "https://api-testnet.ergoplatform.com"


# ---------------------------------------------------------------------------
# Summary & UI
# ---------------------------------------------------------------------------


def get_ui_params(session_data: dict) -> dict:
    """Return Ergo-specific UI parameters for wizard templates."""
    blockchain = session_data.get("blockchain", {})
    network = blockchain.get("network", "testnet")
    return {
        "network_name": NETWORK_NAMES.get(network, network),
        "network": network,
    }


def get_summary_data(session_data: dict) -> dict:
    """Return blockchain summary data for the summary page."""
    blockchain = session_data.get("blockchain", {})
    network = blockchain.get("network", "testnet")
    return {
        "network_name": NETWORK_NAMES.get(network, network),
        "network": network,
        "node_url": blockchain.get("node_url", ""),
        "explorer_url": blockchain.get("explorer_url", ""),
        "deployer_address": blockchain.get("deployer_address", ""),
        "contract_mode": blockchain.get("contract_mode", "deploy"),
        "subscription_ergo_tree": blockchain.get("subscription_ergo_tree", ""),
        "reference_ergo_tree": blockchain.get("reference_ergo_tree", ""),
        "plan_name": blockchain.get("plan_name", "Basic VM"),
        "plan_price_cents": blockchain.get("plan_price_cents", 50),
        "revenue_share_enabled": blockchain.get("revenue_share_enabled", False),
    }


def get_wallet_template() -> str:
    """Return the template name for the engine wallet connection page."""
    return "engine_ergo/wallet.html"


def get_summary_template() -> str:
    """Return the template name for the engine summary section."""
    return "engine_ergo/summary_section.html"


def get_nginx_extra_locations(session_data: dict) -> str:
    """Return extra nginx location blocks for the engine.

    Injected by the installer into the server{} block when building nginx config.
    The Ergo engine proxies the Explorer API so the signup page can query
    the chain without CORS issues.
    """
    blockchain = session_data.get("blockchain", {})
    explorer = _explorer_url(blockchain)

    return f"""
    # Ergo Explorer API proxy -- used by signup page
    location /api/v1/ {{
        proxy_pass {explorer}/api/v1/;
        proxy_set_header Host $proxy_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_ssl_server_name on;
    }}
"""


def get_progress_steps_meta() -> list[dict]:
    """Return step metadata for the progress UI."""
    pre = [
        {"id": "wallet", "label": "Setting up deployer wallet"},
        {"id": "contracts", "label": "Deploying contracts"},
        {"id": "chain_config", "label": "Writing configuration files"},
    ]
    post = [
        {"id": "mint_nft", "label": "Minting admin credential NFT"},
        {"id": "plan", "label": "Creating subscription plan"},
        {"id": "revenue_share", "label": "Configuring revenue sharing"},
    ]
    return pre + post


# ---------------------------------------------------------------------------
# Finalization Steps (pre-provisioner)
# ---------------------------------------------------------------------------


def get_finalization_steps() -> list[tuple]:
    """Return pre-provisioner finalization steps.

    Each tuple: (step_id, display_name, callable[, hint])
    """
    return [
        ("wallet", "Setting up deployer wallet", finalize_wallet),
        (
            "contracts",
            "Deploying contracts",
            finalize_contracts,
            "(compiles ErgoScript guard scripts and deploys to Ergo -- requires funded wallet)",
        ),
        ("chain_config", "Writing configuration files", finalize_chain_config),
    ]


def get_post_finalization_steps() -> list[tuple]:
    """Return post-nginx finalization steps.

    These run after provisioner, ipv6, https, signup, and nginx steps.
    """
    return [
        ("revenue_share", "Configuring revenue sharing", finalize_revenue_share),
        ("mint_nft", "Minting admin credential NFT", finalize_mint_nft),
        ("plan", "Creating subscription plan", finalize_plan),
    ]


# ---------------------------------------------------------------------------
# Helpers (private)
# ---------------------------------------------------------------------------


def _set_blockhost_ownership(path, mode=0o640):
    """Set file to root:blockhost with given mode."""
    try:
        from installer.web.utils import set_blockhost_ownership

        set_blockhost_ownership(path, mode)
    except ImportError:
        os.chmod(str(path), mode)
        try:
            gid = grp.getgrnam("blockhost").gr_gid
            os.chown(str(path), 0, gid)
        except KeyError:
            pass


def _write_yaml(path: Path, data: dict):
    """Write data to YAML file."""
    try:
        from installer.web.utils import write_yaml

        write_yaml(path, data)
    except ImportError:
        try:
            import yaml

            path.write_text(yaml.safe_dump(data, default_flow_style=False))
        except ImportError:
            lines: list[str] = []
            _dict_to_yaml(data, lines, 0)
            path.write_text("\n".join(lines) + "\n")


def _dict_to_yaml(data: dict, lines: list, indent: int):
    """Simple dict to YAML converter (fallback when PyYAML unavailable)."""
    prefix = "  " * indent
    for key, value in data.items():
        if isinstance(value, dict):
            lines.append(f"{prefix}{key}:")
            _dict_to_yaml(value, lines, indent + 1)
        elif isinstance(value, list):
            lines.append(f"{prefix}{key}:")
            for item in value:
                if isinstance(item, dict):
                    lines.append(f"{prefix}  -")
                    _dict_to_yaml(item, lines, indent + 2)
                else:
                    lines.append(f"{prefix}  - {item}")
        elif value is None:
            lines.append(f"{prefix}{key}: null")
        elif isinstance(value, bool):
            lines.append(f"{prefix}{key}: {str(value).lower()}")
        elif isinstance(value, (int, float)):
            lines.append(f"{prefix}{key}: {value}")
        else:
            lines.append(f'{prefix}{key}: "{value}"')


def _discover_bridge() -> str:
    """Read bridge name from first-boot marker or scan /sys/class/net."""
    bridge_file = Path("/run/blockhost/bridge")
    if bridge_file.exists():
        name = bridge_file.read_text().strip()
        if name:
            return name
    for p in Path("/sys/class/net").iterdir():
        if (p / "bridge").is_dir():
            return p.name
    return "br0"


def _bw_env(blockchain: dict) -> dict:
    """Build environment for bw CLI calls."""
    return {
        **os.environ,
        "BLOCKHOST_CONFIG_DIR": str(CONFIG_DIR),
    }


# ---------------------------------------------------------------------------
# Pre-finalization step functions
# ---------------------------------------------------------------------------


def finalize_wallet(config: dict) -> tuple[bool, Optional[str]]:
    """Generate server wallet and save raw private key to deployer.key.

    For wallet_mode == 'generate': runs bhcrypt generate-mnemonic and writes derived key.
    For wallet_mode == 'import': derives key from the provided mnemonic.
    Mnemonic is kept in config for display/backup, but deployer.key contains the raw 64-hex key.
    Idempotent: skips write if file exists with matching content.
    """
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        blockchain = config.get("blockchain", {})
        wallet_mode = blockchain.get("wallet_mode", "generate")
        mnemonic = blockchain.get("deployer_mnemonic", "")

        key_file = CONFIG_DIR / "deployer.key"
        private_key = ""
        address = ""

        if wallet_mode == "generate" and not mnemonic:
            # Generate wallet via bhcrypt generate-mnemonic
            # Returns JSON: { mnemonic, privateKey, address }
            result = subprocess.run(
                ["bhcrypt", "generate-mnemonic"],
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                return False, f"Wallet generation failed: {result.stderr.strip()}"
            try:
                keygen_data = json.loads(result.stdout.strip())
                mnemonic = keygen_data["mnemonic"]
                private_key = keygen_data["privateKey"]
                address = keygen_data["address"]
                blockchain["deployer_mnemonic"] = mnemonic
                blockchain["deployer_address"] = address
                config["blockchain"] = blockchain
            except (json.JSONDecodeError, KeyError) as e:
                return False, f"Could not parse keygen output: {e}"
        elif mnemonic:
            # Import mode or re-run: derive key from existing mnemonic
            words = mnemonic.split()
            if len(words) not in (12, 15, 18, 21, 24):
                return False, f"Invalid mnemonic word count ({len(words)})"
            result = subprocess.run(
                ["bhcrypt", "derive-key"] + words,
                capture_output=True,
                text=True,
                timeout=30,
            )
            if result.returncode != 0:
                return False, f"Key derivation failed: {result.stderr.strip()}"
            try:
                key_data = json.loads(result.stdout.strip())
                private_key = key_data["privateKey"]
                address = key_data["address"]
                blockchain["deployer_address"] = address
                config["blockchain"] = blockchain
            except (json.JSONDecodeError, KeyError) as e:
                return False, f"Could not parse derive-key output: {e}"
        else:
            return False, "No deployer mnemonic in configuration"

        if not private_key or len(private_key) != 64:
            return False, "Failed to derive valid private key"

        # Idempotent: skip if same key already written
        if key_file.exists() and key_file.read_text().strip() == private_key:
            config["_step_result_wallet"] = {"address": address}
            return True, None

        key_file.write_text(private_key)
        _set_blockhost_ownership(key_file, 0o640)

        config["_step_result_wallet"] = {"address": address}
        return True, None
    except FileNotFoundError:
        return False, "bhcrypt not found — is blockhost-engine-ergo installed?"
    except subprocess.TimeoutExpired:
        return False, "Wallet generation timed out"
    except Exception as e:
        return False, str(e)


def finalize_contracts(config: dict) -> tuple[bool, Optional[str]]:
    """Deploy or verify Ergo contracts.

    For contract_mode == 'deploy': use blockhost-deploy-contracts to compile
    and deploy guard scripts.
    For contract_mode == 'existing': verify ErgoTree hashes are present.

    Idempotent: skips deployment if ErgoTree identifiers already recorded.
    """
    try:
        blockchain = config.get("blockchain", {})
        contract_mode = blockchain.get("contract_mode", "deploy")
        network = blockchain.get("network", "testnet")
        node_url = blockchain.get("node_url", "")

        if contract_mode == "existing":
            sub_tree = blockchain.get("subscription_ergo_tree", "")
            ref_tree = blockchain.get("reference_ergo_tree", "")

            if not sub_tree:
                return False, "Subscription ErgoTree required for existing mode"

            if not ERGO_TREE_RE.match(sub_tree):
                return False, f"Invalid subscription ErgoTree: {sub_tree}"
            if ref_tree and not ERGO_TREE_RE.match(ref_tree):
                return False, f"Invalid reference ErgoTree: {ref_tree}"

            blockchain["subscription_contract"] = sub_tree
            if ref_tree:
                blockchain["reference_contract"] = ref_tree
            config["blockchain"] = blockchain
            config["_step_result_contracts"] = {
                "subscription_ergo_tree": sub_tree,
                "reference_ergo_tree": ref_tree,
            }
            return True, None

        # Deploy mode -- skip only if we already have both ErgoTree AND nft_contract
        sub_tree = blockchain.get("subscription_ergo_tree", "")
        if sub_tree and blockchain.get("nft_contract"):
            blockchain["subscription_contract"] = sub_tree
            ref_tree = blockchain.get("reference_ergo_tree", "")
            if ref_tree:
                blockchain["reference_contract"] = ref_tree
            config["blockchain"] = blockchain
            config["_step_result_contracts"] = {
                "subscription_ergo_tree": sub_tree,
                "reference_ergo_tree": ref_tree,
            }
            return True, None

        # Need deployer key to be present (raw 64-hex private key)
        key_file = CONFIG_DIR / "deployer.key"
        if not key_file.exists():
            mnemonic = blockchain.get("deployer_mnemonic", "")
            if not mnemonic:
                return False, "Deployer mnemonic not available"
            result = subprocess.run(
                ["bhcrypt", "derive-key"] + mnemonic.split(),
                capture_output=True, text=True, timeout=30,
            )
            if result.returncode != 0:
                return False, f"Key derivation failed: {result.stderr.strip()}"
            try:
                key_data = json.loads(result.stdout.strip())
                key_file.write_text(key_data["privateKey"])
                _set_blockhost_ownership(key_file, 0o640)
            except (json.JSONDecodeError, KeyError) as e:
                return False, f"Could not parse derive-key output: {e}"

        explorer_url = blockchain.get("explorer_url", "") or _explorer_url(blockchain)
        env = {
            **os.environ,
            "ERGO_NETWORK": network,
            "ERGO_EXPLORER_URL": explorer_url,
        }
        if node_url:
            env["ERGO_NODE_URL"] = node_url

        deploy_script = Path("/usr/bin/blockhost-deploy-contracts")
        if not deploy_script.exists():
            dev_script = Path("/opt/blockhost/scripts/deploy-contracts")
            if dev_script.exists():
                deploy_script = dev_script
            else:
                return False, "blockhost-deploy-contracts not found"

        result = subprocess.run(
            [str(deploy_script)],
            capture_output=True,
            text=True,
            timeout=600,  # 10 min -- testnet confirmation can be slow
            env=env,
        )

        if result.returncode != 0:
            return False, f"Contract deployment failed: {result.stderr or result.stdout}"

        # Parse key=value output from deploy script
        # Format: subscription_ergo_tree=XXXX, reference_ergo_tree=XXXX
        kv: dict[str, str] = {}
        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if "=" in line:
                key, _, val = line.partition("=")
                kv[key.strip()] = val.strip()

        sub_tree = kv.get("subscription_ergo_tree", "")
        sub_address = kv.get("subscription_address", "")
        ref_tree = kv.get("reference_ergo_tree", "")

        if not sub_tree:
            return False, f"Expected subscription_ergo_tree in output, got: {list(kv.keys())}"

        blockchain["subscription_ergo_tree"] = sub_tree
        blockchain["subscription_contract"] = sub_tree
        if sub_address:
            blockchain["subscription_address"] = sub_address
        if ref_tree:
            blockchain["reference_ergo_tree"] = ref_tree
            blockchain["reference_contract"] = ref_tree

        # Registration box tx was created by deploy-contracts — wait for confirmation
        reg_tx = kv.get("registration_tx", "")
        if reg_tx:
            confirmed, err = _wait_for_tx_confirmation(reg_tx, blockchain)
            if not confirmed:
                return False, f"Registration box tx not confirmed: {err}"

        # Set nft_contract to registration tx ID for broker verification.
        # 64-char hex, on-chain proof that the operator deployed. The broker
        # verifies this tx exists on the Ergo explorer.
        if reg_tx:
            blockchain["nft_contract"] = reg_tx

        config["blockchain"] = blockchain
        config["_step_result_contracts"] = {
            "subscription_ergo_tree": sub_tree,
            "reference_ergo_tree": ref_tree,
        }

        # Write contracts.yaml
        contracts_path = CONFIG_DIR / "contracts.yaml"
        contracts_data = {"subscription_ergo_tree": sub_tree}
        if sub_address:
            contracts_data["subscription_address"] = sub_address
        if ref_tree:
            contracts_data["reference_ergo_tree"] = ref_tree
        _write_yaml(contracts_path, contracts_data)
        _set_blockhost_ownership(contracts_path, 0o640)

        return True, None

    except subprocess.TimeoutExpired:
        return False, "Contract deployment timed out (5 minutes)"
    except Exception as e:
        return False, str(e)


def finalize_chain_config(config: dict) -> tuple[bool, Optional[str]]:
    """Write all blockchain configuration files.

    Files written:
    - web3-defaults.yaml (node URL, explorer URL, network, contract trees)
    - blockhost.yaml (server, admin, provisioner config)
    - .env (ERGO_NODE_URL, SUBSCRIPTION_ERGO_TREE, etc.)
    """
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        var_dir = Path("/var/lib/blockhost")
        var_dir.mkdir(parents=True, exist_ok=True)

        blockchain = config.get("blockchain", {})
        provisioner = config.get("provisioner", {})
        network = blockchain.get("network", "testnet")
        node_url = blockchain.get("node_url", "") or _node_url(blockchain)
        explorer_url = blockchain.get("explorer_url", "") or _explorer_url(blockchain)
        sub_tree = blockchain.get("subscription_ergo_tree", "")
        ref_tree = blockchain.get("reference_ergo_tree", "")
        admin_wallet = config.get("admin_wallet", "") or blockchain.get("admin_wallet", "")
        deployer_address = blockchain.get("deployer_address", "")

        # Read server public key if present
        server_pubkey = ""
        pubkey_file = CONFIG_DIR / "server.pubkey"
        if pubkey_file.exists():
            server_pubkey = pubkey_file.read_text().strip()

        bridge = provisioner.get("bridge") or _discover_bridge()

        # --- web3-defaults.yaml ---
        nft_contract = blockchain.get("nft_contract", "")

        web3_blockchain: dict = {
            "network": network,
            "node_url": node_url,
            "explorer_url": explorer_url,
            "subscription_ergo_tree": sub_tree,
            "subscription_contract": sub_tree,
            "nft_contract": nft_contract,
            "server_public_key": server_pubkey,
        }
        if deployer_address:
            web3_blockchain["deployer_address"] = deployer_address
        if ref_tree:
            web3_blockchain["reference_ergo_tree"] = ref_tree
            web3_blockchain["reference_contract"] = ref_tree
        web3_config: dict = {
            "blockchain": web3_blockchain,
        }

        web3_path = CONFIG_DIR / "web3-defaults.yaml"
        if web3_path.exists():
            try:
                import yaml

                existing = yaml.safe_load(web3_path.read_text()) or {}
                existing["blockchain"] = web3_blockchain
                for section, values in web3_config.items():
                    if section == "blockchain":
                        continue
                    if isinstance(values, dict) and isinstance(
                        existing.get(section), dict
                    ):
                        existing[section].update(values)
                    else:
                        existing[section] = values
                web3_config = existing
            except ImportError:
                pass
        _write_yaml(web3_path, web3_config)
        _set_blockhost_ownership(web3_path, 0o640)

        # --- blockhost.yaml ---
        public_secret = config.get("admin_public_secret", "blockhost-access")
        bh_config: dict = {
            "server": {
                "address": deployer_address,
                "key_file": "/etc/blockhost/deployer.key",
            },
            "server_public_key": server_pubkey,
            "public_secret": public_secret,
            "subscription_ergo_tree": sub_tree,
        }

        if provisioner:
            bh_config["provisioner"] = {
                "node": provisioner.get("node", ""),
                "bridge": provisioner.get("bridge", bridge),
                "vmid_start": provisioner.get("vmid_start", 100),
                "vmid_end": provisioner.get("vmid_end", 999),
                "gc_grace_days": provisioner.get("gc_grace_days", 7),
            }

        bh_config["admin"] = {
            "wallet_address": admin_wallet,
            "credential_nft_id": 0,
            "max_command_age": 300,
        }

        admin_commands = config.get("admin_commands", {})
        if admin_commands.get("enabled"):
            bh_config["admin"]["destination_mode"] = admin_commands.get(
                "destination_mode", "self"
            )

        bh_path = CONFIG_DIR / "blockhost.yaml"
        _write_yaml(bh_path, bh_config)
        _set_blockhost_ownership(bh_path, 0o640)

        # --- admin-commands.json ---
        if admin_commands.get("enabled") and admin_commands.get("knock_command"):
            commands_db = {
                "commands": {
                    admin_commands["knock_command"]: {
                        "action": "knock",
                        "description": "Open configured ports temporarily",
                        "params": {
                            "allowed_ports": admin_commands.get("knock_ports", [22]),
                            "default_duration": admin_commands.get(
                                "knock_timeout", 300
                            ),
                        },
                    }
                }
            }
            cmd_path = CONFIG_DIR / "admin-commands.json"
            cmd_path.write_text(json.dumps(commands_db, indent=2) + "\n")
            _set_blockhost_ownership(cmd_path, 0o640)

        # --- admin-signature.key ---
        admin_signature = config.get("admin_signature", "")
        if admin_signature:
            sig_file = CONFIG_DIR / "admin-signature.key"
            sig_file.write_text(admin_signature)
            _set_blockhost_ownership(sig_file, 0o640)

        # --- .env ---
        opt_dir = Path("/opt/blockhost")
        opt_dir.mkdir(parents=True, exist_ok=True)
        env_lines = [
            f"ERGO_NETWORK={network}",
            f"ERGO_NODE_URL={node_url}",
            f"ERGO_EXPLORER_URL={explorer_url}",
            f"SUBSCRIPTION_ERGO_TREE={sub_tree}",
            "DEPLOYER_KEY_FILE=/etc/blockhost/deployer.key",
        ]
        env_path = opt_dir / ".env"
        env_path.write_text("\n".join(env_lines) + "\n")
        _set_blockhost_ownership(env_path, 0o640)

        # --- Initialize vms.json if missing ---
        vms_path = var_dir / "vms.json"
        if not vms_path.exists():
            vms_path.write_text(
                json.dumps(
                    {
                        "vms": {},
                        "next_vmid": provisioner.get("vmid_start", 100),
                        "allocated_ips": [],
                        "allocated_ipv6": [],
                    },
                    indent=2,
                )
            )

        config["_step_result_chain_config"] = {
            "message": "Configuration files written"
        }
        return True, None
    except Exception as e:
        return False, str(e)


# ---------------------------------------------------------------------------
# Post-finalization step functions
# ---------------------------------------------------------------------------


def finalize_mint_nft(config: dict) -> tuple[bool, Optional[str]]:
    """Mint admin credential NFT on Ergo.

    Calls blockhost-mint-nft with the admin wallet address as owner.
    On Ergo, token ID = first input box ID (EIP-4 standard).
    Idempotent: if NFT already minted (existing contract mode), logs and returns.
    """
    try:
        blockchain = config.get("blockchain", {})
        admin_wallet = (
            config.get("admin_wallet", "")
            or blockchain.get("admin_wallet", "")
        )

        if not admin_wallet:
            return False, "Admin wallet address not configured"

        if not validate_ergo_address(admin_wallet):
            return False, f"Invalid admin wallet address (expected Base58): {admin_wallet}"

        # Build encrypted connection details for the NFT
        user_encrypted = ""
        admin_signature = config.get("admin_signature", "")
        https_cfg = config.get("https", {})
        if not https_cfg:
            https_file = CONFIG_DIR / "https.json"
            if https_file.exists():
                try:
                    https_cfg = json.loads(https_file.read_text())
                except Exception:
                    pass
        server_addr = https_cfg.get("ipv6_address") or https_cfg.get("hostname", "")

        if server_addr and admin_signature:
            connection_details = json.dumps({
                "hostname": server_addr,
                "port": 22,
                "username": "admin",
            })
            try:
                result = subprocess.run(
                    ["bhcrypt", "encrypt-symmetric", admin_signature, connection_details],
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                if result.returncode == 0 and result.stdout.strip():
                    user_encrypted = result.stdout.strip()
                    if user_encrypted.startswith("0x"):
                        user_encrypted = user_encrypted[2:]
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass

        cmd = [
            "blockhost-mint-nft",
            "--owner-wallet", admin_wallet,
        ]
        if user_encrypted:
            cmd.extend(["--user-encrypted", user_encrypted])

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,  # 10 min -- testnet confirmation can be slow
        )

        if result.returncode != 0:
            return False, f"NFT minting failed: {result.stderr or result.stdout}"

        # stdout is the token ID (64-char hex = box ID of first input)
        token_id = result.stdout.strip()

        # The mint script also prints the txId to stderr — extract it
        tx_id = ""
        for line in (result.stderr or "").split("\n"):
            if line.startswith("Transaction submitted: "):
                tx_id = line.split(": ", 1)[1].strip()
                break

        # Wait for on-chain confirmation before proceeding
        if tx_id:
            confirmed, err = _wait_for_tx_confirmation(tx_id, blockchain)
            if not confirmed:
                return False, f"NFT minting tx not confirmed: {err}"

        config["_step_result_mint_nft"] = {
            "token_id": token_id,
            "owner": admin_wallet,
        }
        return True, None
    except subprocess.TimeoutExpired:
        return False, "NFT minting timed out (waited for Ergo confirmation)"
    except Exception as e:
        return False, str(e)


def _is_testing_mode() -> bool:
    """Check if testing mode is enabled (/etc/blockhost/.testing-mode exists)."""
    return TESTING_MODE_FILE.exists()


def _get_interval_blocks() -> int:
    """Get the collection interval in blocks.

    Testing mode: 3 blocks (~6 minutes) for rapid iteration.
    Production:   720 blocks (~1 day).
    """
    if _is_testing_mode():
        return TESTING_INTERVAL_BLOCKS
    return BLOCKS_PER_DAY


def finalize_plan(config: dict) -> tuple[bool, Optional[str]]:
    """Create default subscription plan via bw CLI.

    In testing mode (/etc/blockhost/.testing-mode exists), the plan uses
    shorter intervals (3 blocks instead of 720) so the monitor can collect
    funds every few minutes instead of daily.
    """
    try:
        blockchain = config.get("blockchain", {})
        plan_name = blockchain.get("plan_name", "Basic VM")
        plan_price = blockchain.get("plan_price_cents", 50)
        testing = _is_testing_mode()
        interval_blocks = _get_interval_blocks()

        if testing:
            plan_name = f"{plan_name} (TEST)"

        env = _bw_env(blockchain)

        cmd = [
            "bw", "plan", "create",
            plan_name,
            str(plan_price),
            "--interval-blocks", str(interval_blocks),
        ]

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,  # 10 min -- testnet confirmation can be slow
            env=env,
        )

        if result.returncode != 0:
            return False, f"Plan creation failed: {result.stderr or result.stdout}"

        # stdout is the txId — wait for on-chain confirmation
        tx_id = result.stdout.strip()
        if tx_id:
            confirmed, err = _wait_for_tx_confirmation(tx_id, blockchain)
            if not confirmed:
                return False, f"Plan creation tx not confirmed: {err}"

        mode_label = (
            f"TESTING MODE: {interval_blocks} blocks/interval"
            if testing
            else f"{interval_blocks} blocks/interval (~1 day)"
        )
        config["_step_result_plan"] = {
            "plan_name": plan_name,
            "price": f"{plan_price} cents/day",
            "interval_blocks": interval_blocks,
            "mode": mode_label,
        }
        return True, None
    except FileNotFoundError:
        return False, "bw CLI not found"
    except subprocess.TimeoutExpired:
        return False, "Plan creation timed out (waited for Ergo confirmation)"
    except Exception as e:
        return False, str(e)


def finalize_revenue_share(config: dict) -> tuple[bool, Optional[str]]:
    """Write addressbook.json and revenue-share.json. Enable blockhost-monitor."""
    try:
        CONFIG_DIR.mkdir(parents=True, exist_ok=True)
        blockchain = config.get("blockchain", {})
        admin_wallet = (
            config.get("admin_wallet", "")
            or blockchain.get("admin_wallet", "")
        )
        deployer_address = blockchain.get("deployer_address", "")

        # Build addressbook entries (Ergo Base58 addresses)
        addressbook: dict = {}

        if admin_wallet:
            addressbook["admin"] = {"address": admin_wallet}

        if deployer_address:
            addressbook["server"] = {
                "address": deployer_address,
                "keyfile": "/etc/blockhost/deployer.key",
            }

        if blockchain.get("revenue_share_dev"):
            addressbook["dev"] = {"address": admin_wallet}

        if blockchain.get("revenue_share_broker"):
            addressbook["broker"] = {"address": admin_wallet}

        # Try ab --init CLI first
        ab_init_used = False
        if admin_wallet and deployer_address:
            try:
                cmd = ["ab", "--init", admin_wallet, deployer_address]
                if blockchain.get("revenue_share_dev"):
                    cmd.append(admin_wallet)
                if blockchain.get("revenue_share_broker"):
                    cmd.append(admin_wallet)
                cmd.append("/etc/blockhost/deployer.key")

                result = subprocess.run(
                    cmd,
                    capture_output=True,
                    text=True,
                    timeout=30,
                )
                ab_init_used = result.returncode == 0
            except FileNotFoundError:
                pass

        if not ab_init_used:
            ab_path = CONFIG_DIR / "addressbook.json"
            if not ab_path.exists() or not json.loads(ab_path.read_text() or "{}"):
                ab_path.write_text(json.dumps(addressbook, indent=2) + "\n")
                _set_blockhost_ownership(ab_path, 0o640)

        # Write revenue-share.json
        rev_enabled = blockchain.get("revenue_share_enabled", False)
        rev_percent = blockchain.get("revenue_share_percent", 1.0)
        recipients: list[dict] = []

        if rev_enabled:
            active_roles = [
                r for r in ["dev", "broker"]
                if blockchain.get(f"revenue_share_{r}")
            ]
            share_each = rev_percent / max(len(active_roles), 1)
            for role in active_roles:
                recipients.append({"role": role, "percent": share_each})

        rev_config = {
            "enabled": rev_enabled,
            "total_percent": rev_percent if rev_enabled else 0.0,
            "recipients": recipients,
        }

        rev_path = CONFIG_DIR / "revenue-share.json"
        rev_path.write_text(json.dumps(rev_config, indent=2) + "\n")
        _set_blockhost_ownership(rev_path, 0o640)

        # Enable blockhost-monitor service.
        svc_installed = Path("/lib/systemd/system/blockhost-monitor.service")
        svc_examples = Path("/usr/share/blockhost/examples/blockhost-monitor.service")
        svc_etc = Path("/etc/systemd/system/blockhost-monitor.service")
        if not svc_installed.exists() and not svc_etc.exists() and svc_examples.exists():
            import shutil
            shutil.copy2(str(svc_examples), str(svc_etc))
        subprocess.run(["systemctl", "daemon-reload"], capture_output=True, timeout=30)
        subprocess.run(
            ["systemctl", "enable", "blockhost-monitor"],
            capture_output=True,
            timeout=30,
        )

        config["_step_result_revenue_share"] = {
            "message": "Addressbook initialized"
        }
        return True, None
    except Exception as e:
        return False, str(e)
