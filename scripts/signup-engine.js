/**
 * Signup page engine for Ergo (BlockHost).
 *
 * Loaded after an inline CONFIG block injected by generate-signup-page.
 * Handles:
 *   1. EIP-12 Nautilus wallet detection and connection
 *   2. Plan fetching from plan boxes via Ergo node/explorer REST API
 *   3. Cost calculation
 *   4. Subscription transaction building (inline Sigma serialization + EIP-12)
 *
 * Expected global: CONFIG (set by the inline script block in signup-template.html)
 *
 * Required DOM IDs:
 *   step1-num, step2-num, step3-num
 *   wallet-list, no-wallets, wallet-not-connected, wallet-connected, wallet-address
 *   plan-select, plan-detail, days-input, total-cost
 *   btn-subscribe, subscribe-status
 *   result-card, result-content
 *
 * CSS classes toggled: hidden, done, error
 */

(function () {
    'use strict';

    // ── API base URLs ─────────────────────────────────────────────────────

    /**
     * Ergo node proxy base URL.
     * Requests go through a local proxy to avoid CORS issues in the browser.
     * The proxy server maps /api/v0/* to the configured node URL.
     */
    function nodeBase() {
        return CONFIG.nodeUrl || '/api/v0';
    }

    /**
     * Ergo explorer API base URL.
     * Used for indexed queries (balances, token lookups, tx history).
     */
    function explorerBase() {
        return CONFIG.explorerUrl || '/explorer/api/v1';
    }

    /**
     * Fetch helper with basic retry logic for rate limiting.
     *
     * @param {string} url - Full URL to fetch
     * @param {object} [opts] - Fetch options
     * @returns {Promise<unknown>}
     */
    async function apiFetch(url, opts) {
        opts = opts || {};

        async function doFetch() {
            return fetch(url, opts);
        }

        var res = await doFetch();

        // Retry once on 429 (rate limit) after a short delay
        if (res.status === 429) {
            await new Promise(function (r) { setTimeout(r, 1500); });
            res = await doFetch();
        }

        if (!res.ok) {
            if (res.status === 404) return null;
            var errBody = await res.text().catch(function () { return ''; });
            throw new Error('API ' + res.status + ': ' + errBody);
        }

        return res.json();
    }

    /**
     * Fetch from the Ergo node.
     */
    async function nodeFetch(endpoint, body) {
        var base = nodeBase();
        var method = body != null ? 'POST' : 'GET';
        var headers = {};
        var fetchBody;
        if (body != null) {
            headers['Content-Type'] = 'application/json';
            fetchBody = JSON.stringify(body);
        }
        return apiFetch(base + endpoint, {
            method: method,
            headers: headers,
            body: fetchBody,
        });
    }

    /**
     * Fetch from the Ergo explorer.
     */
    async function explorerFetch(endpoint) {
        return apiFetch(explorerBase() + endpoint);
    }

    // ── ECIES encryption (secp256k1 ECDH + HKDF-SHA256 + AES-GCM) ───────
    // Wire format: ephemeralPub(65) || IV(12) || ciphertext+tag
    // Matches the server-side eciesDecrypt() in src/crypto.ts.
    //
    // Uses the noble-curves and noble-hashes ES module builds loaded from esm.run.

    var _eciesReady = false;
    var _secp256k1 = null;
    var _hkdf = null;
    var _sha256 = null;
    var _randomBytes = null;

    /**
     * Lazy-load noble crypto libraries from CDN (esm.run -> jsDelivr).
     * Called once before the first ECIES encrypt.
     */
    async function ensureEcies() {
        if (_eciesReady) return;
        var mod;
        mod = await import('https://esm.run/@noble/curves@1.4.0/secp256k1');
        _secp256k1 = mod.secp256k1;
        mod = await import('https://esm.run/@noble/hashes@1.4.0/hkdf');
        _hkdf = mod.hkdf;
        mod = await import('https://esm.run/@noble/hashes@1.4.0/sha256');
        _sha256 = mod.sha256;
        mod = await import('https://esm.run/@noble/hashes@1.4.0/utils');
        _randomBytes = mod.randomBytes;
        _eciesReady = true;
    }

    function hexToBytes(hex) {
        hex = hex.replace(/^0x/, '');
        var out = new Uint8Array(hex.length / 2);
        for (var i = 0; i < out.length; i++) {
            out[i] = parseInt(hex.substr(i * 2, 2), 16);
        }
        return out;
    }

    function bytesToHex(bytes) {
        return Array.from(bytes).map(function (b) {
            return b.toString(16).padStart(2, '0');
        }).join('');
    }

    /**
     * ECIES encrypt plaintext with the server's secp256k1 public key.
     *
     * @param {string} serverPubKeyHex - 33 or 65 byte compressed/uncompressed pubkey hex
     * @param {string} plaintext
     * @returns {Promise<string>} hex-encoded ciphertext
     */
    async function eciesEncrypt(serverPubKeyHex, plaintext) {
        await ensureEcies();
        var serverPubBytes = hexToBytes(serverPubKeyHex);
        var ephPriv = _randomBytes(32);
        var ephPub = _secp256k1.getPublicKey(ephPriv, false); // uncompressed, 65 bytes
        var shared = _secp256k1.getSharedSecret(ephPriv, serverPubBytes, false);
        var sharedX = shared.slice(1, 33);
        var encKey = _hkdf(_sha256, sharedX, new Uint8Array(0), new Uint8Array(0), 32);
        var iv = _randomBytes(12);
        var cryptoKey = await crypto.subtle.importKey('raw', encKey, { name: 'AES-GCM' }, false, ['encrypt']);
        var ptBytes = new TextEncoder().encode(plaintext);
        var ctWithTag = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, cryptoKey, ptBytes);
        var result = new Uint8Array(ephPub.length + iv.length + ctWithTag.byteLength);
        result.set(ephPub, 0);
        result.set(iv, ephPub.length);
        result.set(new Uint8Array(ctWithTag), ephPub.length + iv.length);
        return bytesToHex(result);
    }

    // ── SHAKE256 + AES-GCM symmetric decryption ────────────────────────────
    //
    // Matches the server-side symmetricEncrypt() in src/crypto.ts.
    // Key derivation: SHAKE256(signatureBytes, 32 bytes)
    // Wire format:    IV(12) + ciphertext + authTag(16)

    var _shake256 = null;

    /** Lazy-load SHAKE256 from noble-hashes CDN. */
    async function ensureShake256() {
        if (_shake256) return;
        var mod = await import('https://esm.run/@noble/hashes@1.4.0/sha3');
        _shake256 = mod.shake256;
    }

    /** Derive a 32-byte AES key from signature bytes using SHAKE256. */
    function deriveSymmetricKey(signatureBytes) {
        return _shake256(signatureBytes, { dkLen: 32 });
    }

    /** Decrypt AES-256-GCM ciphertext using a SHAKE256-derived key.
     *  @param {Uint8Array} keyBytes - 32-byte AES key
     *  @param {string} ciphertextHex - IV(12) + ciphertext + tag(16), hex encoded
     *  @returns {Promise<string>} decrypted UTF-8 string
     */
    async function decryptAesGcm(keyBytes, ciphertextHex) {
        var data = hexToBytes(ciphertextHex);
        if (data.length < 28) throw new Error('Ciphertext too short');
        var iv = data.slice(0, 12);
        var ct = data.slice(12);
        var key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
        var decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, ct);
        return new TextDecoder().decode(decrypted);
    }

    // ── Sigma serialization helpers ────────────────────────────────────────
    //
    // Inline implementation of Sigma type serialization for Ergo registers.
    // No external dependencies — pure browser JS.
    //
    // Type codes (from sigmastate-interpreter):
    //   SBoolean = 1, SByte = 2, SShort = 3, SInt = 4, SLong = 5
    //   SColl = 12 (parameterised), STuple = 12 with tuple encoding
    //   SPair = tuple of 2
    //
    // The Sigma serialization format uses:
    //   - Type descriptors prefix each constant
    //   - ZigZag VLQ encoding for Int and Long
    //   - Length-prefixed byte arrays for Coll[Byte]
    //   - Nested type descriptors for pairs/tuples

    /** Concatenate multiple Uint8Arrays. */
    function concatBytes(arrays) {
        var total = 0;
        for (var i = 0; i < arrays.length; i++) total += arrays[i].length;
        var result = new Uint8Array(total);
        var offset = 0;
        for (var i = 0; i < arrays.length; i++) {
            result.set(arrays[i], offset);
            offset += arrays[i].length;
        }
        return result;
    }

    /**
     * Encode an unsigned integer as VLQ (Variable Length Quantity).
     * Used internally for lengths and zigzag-encoded values.
     * @param {number|bigint} n - Non-negative integer
     * @returns {Uint8Array}
     */
    function vlqEncode(n) {
        if (typeof n === 'bigint') {
            if (n === 0n) return new Uint8Array([0]);
            var bytes = [];
            while (n > 0n) {
                var b = Number(n & 0x7Fn);
                n >>= 7n;
                if (n > 0n) b |= 0x80;
                bytes.push(b);
            }
            return new Uint8Array(bytes);
        }
        if (n === 0) return new Uint8Array([0]);
        var bytes = [];
        while (n > 0) {
            var b = n & 0x7F;
            n >>>= 7;
            if (n > 0) b |= 0x80;
            bytes.push(b);
        }
        return new Uint8Array(bytes);
    }

    /**
     * ZigZag encode a signed 32-bit integer.
     * Maps signed integers to unsigned: 0->0, -1->1, 1->2, -2->3, 2->4, ...
     * @param {number} n - Signed integer
     * @returns {number} Unsigned zigzag value
     */
    function zigzagEncodeInt(n) {
        return (n << 1) ^ (n >> 31);
    }

    /**
     * ZigZag encode a signed 64-bit integer (as BigInt).
     * @param {bigint} n - Signed BigInt
     * @returns {bigint} Unsigned zigzag value
     */
    function zigzagEncodeLong(n) {
        if (typeof n !== 'bigint') n = BigInt(n);
        return (n << 1n) ^ (n >> 63n);
    }

    // Sigma type codes
    var SIGMA_BOOLEAN = 1;
    var SIGMA_BYTE = 2;
    var SIGMA_SHORT = 3;
    var SIGMA_INT = 4;
    var SIGMA_LONG = 5;

    // Collection type code: 0x0c (12) with embedded element type
    // Byte 0x0e = SColl(SByte) header (12 + 2 packed)

    /**
     * Encode an SInt value as Sigma serialized hex.
     * Format: type_byte(0x04) + VLQ(zigzag(value))
     * @param {number} value - 32-bit signed integer
     * @returns {string} Hex string
     */
    function sigmaEncodeInt(value) {
        var typePrefix = new Uint8Array([SIGMA_INT]);
        var encoded = vlqEncode(zigzagEncodeInt(value));
        return bytesToHex(concatBytes([typePrefix, encoded]));
    }

    /**
     * Encode an SLong value as Sigma serialized hex.
     * Format: type_byte(0x05) + VLQ(zigzag(value))
     * @param {bigint} value - 64-bit signed integer
     * @returns {string} Hex string
     */
    function sigmaEncodeLong(value) {
        if (typeof value !== 'bigint') value = BigInt(value);
        var typePrefix = new Uint8Array([SIGMA_LONG]);
        var encoded = vlqEncode(zigzagEncodeLong(value));
        return bytesToHex(concatBytes([typePrefix, encoded]));
    }

    /**
     * Encode a SColl[SByte] value as Sigma serialized hex.
     * Format: type_header(0x0e) + VLQ(length) + raw_bytes
     * @param {Uint8Array|string} data - Raw bytes or hex string
     * @returns {string} Hex string
     */
    function sigmaEncodeCollByte(data) {
        if (typeof data === 'string') data = hexToBytes(data);
        // 0x0e = SColl[SByte] type descriptor
        var typePrefix = new Uint8Array([0x0e]);
        var lenEnc = vlqEncode(data.length);
        return bytesToHex(concatBytes([typePrefix, lenEnc, data]));
    }

    /**
     * Encode raw bytes as VLQ length + data (no type prefix).
     * Used inside compound types where the type is already declared.
     * @param {Uint8Array|string} data
     * @returns {Uint8Array}
     */
    function sigmaEncodeCollByteRaw(data) {
        if (typeof data === 'string') data = hexToBytes(data);
        var lenEnc = vlqEncode(data.length);
        return concatBytes([lenEnc, data]);
    }

    /**
     * Encode an Int value as VLQ zigzag (no type prefix).
     * @param {number} value
     * @returns {Uint8Array}
     */
    function sigmaEncodeIntRaw(value) {
        return vlqEncode(zigzagEncodeInt(value));
    }

    /**
     * Encode a Long value as VLQ zigzag (no type prefix).
     * @param {bigint} value
     * @returns {Uint8Array}
     */
    function sigmaEncodeLongRaw(value) {
        if (typeof value !== 'bigint') value = BigInt(value);
        return vlqEncode(zigzagEncodeLong(value));
    }

    // ── Register type prefixes (Sigma serialized) ──────────────────────
    //
    // Derived from sigmastate-interpreter TypeSerializer and verified
    // against Fleet SDK serializer output:
    //   Primitive types 1-6: single byte = type code
    //   SColl(SByte) = 12 + 2 = 14 = 0x0e
    //   STuple2(T1, T2): byte1 = 12 * (T1.code + 1), byte2 = T2 type descriptor
    //   STupleN (N>=3): byte1 = 0x60, byte2 = N, then N element type bytes
    //
    // R4: SPair(SInt, SColl[SByte])     -> 0x3c 0x0e  (12*(4+1)=60, SColl[SByte]=14)
    // R5: STuple(SLong, SLong, SLong)   -> 0x60 0x03 0x05 0x05 0x05
    // R6: SPair(SLong, SLong)           -> 0x48 0x05  (12*(5+1)=72, SLong=5)
    // R7: SColl[SByte]                  -> 0x0e
    // R8: SColl[SByte]                  -> 0x0e

    /**
     * Encode R4: SPair(SInt, SColl[SByte]) — (planId, subscriberErgoTree).
     * @param {number} planId
     * @param {string} subscriberErgoTree - ErgoTree hex string
     * @returns {string} Sigma serialized hex
     */
    function encodeR4(planId, subscriberErgoTree) {
        var typePrefix = new Uint8Array([0x3c, 0x0e]);
        var intData = sigmaEncodeIntRaw(planId);
        var etBytes = hexToBytes(subscriberErgoTree);
        var collData = sigmaEncodeCollByteRaw(etBytes);
        return bytesToHex(concatBytes([typePrefix, intData, collData]));
    }

    /**
     * Encode R5: STuple(SLong, SLong, SLong) — (amountRemaining, ratePerInterval, intervalMs).
     *
     * General tuple encoding:
     *   0x60 = general tuple type marker
     *   0x03 = number of elements
     *   0x05 0x05 0x05 = element types (SLong, SLong, SLong)
     *   Then: data for each element (VLQ zigzag encoded)
     *
     * @param {bigint} amountRemaining
     * @param {bigint} ratePerInterval
     * @param {bigint} intervalMs
     * @returns {string} Sigma serialized hex
     */
    function encodeR5(amountRemaining, ratePerInterval, intervalMs) {
        var typePrefix = new Uint8Array([0x60, 0x03, 0x05, 0x05, 0x05]);
        var d1 = sigmaEncodeLongRaw(amountRemaining);
        var d2 = sigmaEncodeLongRaw(ratePerInterval);
        var d3 = sigmaEncodeLongRaw(intervalMs);
        return bytesToHex(concatBytes([typePrefix, d1, d2, d3]));
    }

    /**
     * Encode R6: SPair(SLong, SLong) — (lastCollected, expiry).
     * @param {bigint} lastCollected
     * @param {bigint} expiry
     * @returns {string} Sigma serialized hex
     */
    function encodeR6(lastCollected, expiry) {
        var typePrefix = new Uint8Array([0x48, 0x05]);
        var d1 = sigmaEncodeLongRaw(lastCollected);
        var d2 = sigmaEncodeLongRaw(expiry);
        return bytesToHex(concatBytes([typePrefix, d1, d2]));
    }

    /**
     * Encode R7: SColl[SByte] — paymentTokenId.
     * @param {string} tokenIdHex - 64 hex chars for token ID, or empty for native ERG
     * @returns {string} Sigma serialized hex
     */
    function encodeR7(tokenIdHex) {
        return sigmaEncodeCollByte(tokenIdHex || '');
    }

    /**
     * Encode R8: SColl[SByte] — userEncrypted.
     * @param {string} encryptedHex - ECIES encrypted data hex
     * @returns {string} Sigma serialized hex
     */
    function encodeR8(encryptedHex) {
        return sigmaEncodeCollByte(encryptedHex || '');
    }

    // ── Sigma deserialization helpers (for reading plan box registers) ────

    /**
     * Decode a VLQ-encoded unsigned integer from a byte array.
     * @param {Uint8Array} bytes
     * @param {number} offset
     * @returns {{ value: bigint, offset: number }}
     */
    function vlqDecode(bytes, offset) {
        var result = 0n;
        var shift = 0n;
        while (offset < bytes.length) {
            var b = bytes[offset];
            offset++;
            result |= BigInt(b & 0x7F) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7n;
        }
        return { value: result, offset: offset };
    }

    /**
     * ZigZag decode an unsigned integer back to signed.
     * @param {bigint} n
     * @returns {bigint}
     */
    function zigzagDecode(n) {
        return (n >> 1n) ^ -(n & 1n);
    }

    /**
     * Decode a Sigma SColl[SByte] value from hex (with type prefix 0x0e).
     * @param {string} hex - Full sigma-serialized hex including type byte
     * @returns {Uint8Array} Raw bytes
     */
    function sigmaDecodeCollByte(hex) {
        var bytes = hexToBytes(hex);
        if (bytes[0] !== 0x0e) return new Uint8Array(0);
        var decoded = vlqDecode(bytes, 1);
        var len = Number(decoded.value);
        return bytes.slice(decoded.offset, decoded.offset + len);
    }

    /**
     * Decode a Sigma SInt value from hex (with type prefix 0x04).
     * @param {string} hex
     * @returns {number}
     */
    function sigmaDecodeInt(hex) {
        var bytes = hexToBytes(hex);
        if (bytes[0] !== SIGMA_INT) return 0;
        var decoded = vlqDecode(bytes, 1);
        return Number(zigzagDecode(decoded.value));
    }

    /**
     * Decode a Sigma SLong value from hex (with type prefix 0x05).
     * @param {string} hex
     * @returns {bigint}
     */
    function sigmaDecodeLong(hex) {
        var bytes = hexToBytes(hex);
        if (bytes[0] !== SIGMA_LONG) return 0n;
        var decoded = vlqDecode(bytes, 1);
        return zigzagDecode(decoded.value);
    }

    /**
     * Decode plan box register R4 (Coll[Byte] = plan name UTF-8).
     * @param {string} hex
     * @returns {string}
     */
    function decodePlanName(hex) {
        try {
            var bytes = sigmaDecodeCollByte(hex);
            return new TextDecoder().decode(bytes);
        } catch (e) {
            return '';
        }
    }

    /**
     * Decode plan box register R5 (Long = price per day in nanoERG).
     * @param {string} hex
     * @returns {bigint}
     */
    function decodePricePerDay(hex) {
        return sigmaDecodeLong(hex);
    }

    /**
     * Decode plan box register R6 (Int = plan ID).
     * @param {string} hex
     * @returns {number}
     */
    function decodePlanId(hex) {
        return sigmaDecodeInt(hex);
    }

    // ── Ergo address helpers ──────────────────────────────────────────────
    //
    // Ergo uses a custom Base58 address encoding.
    // Address byte layout:
    //   byte 0: type byte (network + address type)
    //     P2PK mainnet: 0x01 (1)
    //     P2PK testnet: 0x11 (17)
    //     P2S  mainnet: 0x00 ... actually:
    //       networkType: mainnet=0x00, testnet=0x10
    //       addressType: P2PK=0x01, P2SH=0x02, P2S=0x03
    //       typeByte = networkType | addressType
    //   bytes 1..N: content (33-byte pubkey for P2PK, or ErgoTree hash for P2SH, or ErgoTree for P2S)
    //   last 4 bytes: checksum (first 4 bytes of blake2b256 of prefix + content)

    var BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    function base58Decode(str) {
        var bytes = [0];
        for (var i = 0; i < str.length; i++) {
            var carry = BASE58_ALPHABET.indexOf(str[i]);
            if (carry < 0) throw new Error('Invalid Base58 character: ' + str[i]);
            for (var j = 0; j < bytes.length; j++) {
                carry += bytes[j] * 58;
                bytes[j] = carry & 0xFF;
                carry >>= 8;
            }
            while (carry > 0) {
                bytes.push(carry & 0xFF);
                carry >>= 8;
            }
        }
        // Add leading zeros
        for (var i = 0; i < str.length && str[i] === '1'; i++) {
            bytes.push(0);
        }
        return new Uint8Array(bytes.reverse());
    }

    /**
     * Extract ErgoTree hex from an Ergo Base58 address.
     * For P2PK addresses: ErgoTree = 0008cd + compressed_pubkey (33 bytes)
     * For P2S addresses: the content IS the ErgoTree
     * @param {string} address - Base58 Ergo address
     * @returns {string} ErgoTree hex
     */
    function ergoTreeFromAddress(address) {
        var decoded = base58Decode(address);
        // Remove checksum (last 4 bytes)
        var withoutChecksum = decoded.slice(0, decoded.length - 4);
        var typeByte = withoutChecksum[0];
        var content = withoutChecksum.slice(1);
        var addressType = typeByte & 0x0F;

        if (addressType === 1) {
            // P2PK: ErgoTree = 0008cd + 33-byte compressed pubkey
            return '0008cd' + bytesToHex(content);
        } else if (addressType === 3) {
            // P2S: content is the ErgoTree itself
            return bytesToHex(content);
        } else if (addressType === 2) {
            // P2SH: content is the script hash (26 bytes), but we can't reconstruct ErgoTree
            throw new Error('P2SH address: cannot extract ErgoTree without script');
        }
        throw new Error('Unknown address type: ' + addressType);
    }

    /**
     * Truncate address for display.
     * @param {string} address
     * @returns {string}
     */
    function truncateAddress(address) {
        if (address.length <= 20) return address;
        return address.slice(0, 10) + '...' + address.slice(-8);
    }

    // ── EIP-12 Wallet connection (Nautilus) ──────────────────────────────

    /** @type {object|null} EIP-12 ergo context handle */
    var ergoCtx = null;
    /** @type {string} connected wallet address (Base58) */
    var connectedAddress = '';
    /** @type {string} connected wallet ErgoTree hex */
    var connectedErgoTree = '';

    /**
     * Wait for the ergoConnector object to be injected by Nautilus.
     * Nautilus injects window.ergoConnector asynchronously after page load.
     * @param {number} [timeout=3000] - Max wait time in ms
     * @returns {Promise<boolean>}
     */
    function waitForErgoConnector(timeout) {
        timeout = timeout || 3000;
        return new Promise(function (resolve) {
            if (window.ergoConnector) return resolve(true);
            var t0 = Date.now();
            var timer = setInterval(function () {
                if (window.ergoConnector) { clearInterval(timer); resolve(true); }
                else if (Date.now() - t0 >= timeout) { clearInterval(timer); resolve(false); }
            }, 100);
        });
    }

    /**
     * Detect available EIP-12 wallets and show connect buttons.
     */
    function detectWallets() {
        var walletList = document.getElementById('wallet-list');
        var connector = window.ergoConnector;

        if (!connector || typeof connector !== 'object') {
            document.getElementById('no-wallets').classList.remove('hidden');
            return;
        }

        var found = 0;

        function makeBtn(walletKey) {
            var walletInfo = connector[walletKey];
            if (!walletInfo || typeof walletInfo.connect !== 'function') return;

            var btn = document.createElement('button');
            btn.className = 'wallet-btn';
            var rawName = walletInfo.name || walletKey;
            btn.textContent = rawName.charAt(0).toUpperCase() + rawName.slice(1);
            // Add wallet icon if available
            if (walletInfo.icon) {
                var img = document.createElement('img');
                img.src = walletInfo.icon;
                img.style.cssText = 'width:20px;height:20px;margin-right:8px;vertical-align:middle;border-radius:4px';
                btn.prepend(img);
            }
            btn.addEventListener('click', function () { connectWallet(walletKey); });
            walletList.appendChild(btn);
            found++;
        }

        // Known EIP-12 wallets
        var knownWallets = ['nautilus', 'safew', 'minotaur'];
        for (var i = 0; i < knownWallets.length; i++) {
            if (connector[knownWallets[i]]) makeBtn(knownWallets[i]);
        }

        // Catch any other EIP-12 wallets not in the known list
        var keys = Object.keys(connector);
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k];
            if (knownWallets.indexOf(key) === -1 && connector[key] && typeof connector[key].connect === 'function') {
                makeBtn(key);
            }
        }

        if (found === 0) {
            document.getElementById('no-wallets').classList.remove('hidden');
        }
    }

    /**
     * Connect to a specific EIP-12 wallet.
     * @param {string} walletKey - Wallet identifier (e.g. 'nautilus')
     */
    async function connectWallet(walletKey) {
        try {
            var connected = await window.ergoConnector[walletKey].connect();
            if (!connected) throw new Error('Connection rejected by user');

            // The ergo API is now globally available (EIP-12 spec)
            ergoCtx = window.ergo;
            if (!ergoCtx) {
                // Some wallets use getContext()
                ergoCtx = await window.ergoConnector[walletKey].getContext();
            }
            if (!ergoCtx) throw new Error('Failed to get wallet context');

            var addresses = await ergoCtx.get_used_addresses();
            if (!addresses || addresses.length === 0) {
                var unused = await ergoCtx.get_unused_addresses();
                connectedAddress = (unused && unused[0]) ? unused[0] : '';
            } else {
                connectedAddress = addresses[0];
            }

            if (!connectedAddress) {
                throw new Error('No address returned from wallet');
            }

            // Derive ErgoTree from address
            connectedErgoTree = ergoTreeFromAddress(connectedAddress);

            var display = truncateAddress(connectedAddress);

            document.getElementById('wallet-not-connected').classList.add('hidden');
            document.getElementById('wallet-connected').classList.remove('hidden');
            document.getElementById('wallet-address').textContent = display;
            updateStep(1, 'done');

            // Enable days input and trigger cost recalculation
            document.getElementById('days-input').disabled = false;
            updateCost();

            // Also kick off plan loading if it hasn't happened yet
            if (plans.length === 0) loadPlans();

            // Show View My Servers wallet mode and load NFTs
            document.getElementById('servers-not-connected').classList.add('hidden');
            loadUserNfts();

            // Show admin commands section
            document.getElementById('admin-not-connected').classList.add('hidden');
            document.getElementById('admin-connected').classList.remove('hidden');

        } catch (err) {
            console.error('connectWallet error:', err);
            showStatus('subscribe-status', 'Wallet connection failed: ' + escapeHtml(err.message || err), 'error');
            updateStep(1, 'error');
        }
    }

    // ── Plan data (fetched from explorer/node) ──────────────────────────

    /**
     * Plan record.
     * @typedef {{ planId: number, name: string, pricePerDay: bigint, paymentAsset: string }} Plan
     */

    /** @type {Plan[]} */
    var plans = [];

    /**
     * Parse plan data from an Ergo box's additional registers.
     *
     * Plan box register layout (created by `bw plan create`):
     *   R4: Coll[Byte] (UTF-8 plan name)
     *   R5: Long (price per day in nanoERG)
     *   R6: Int (plan ID)
     *
     * @param {object} box - Box object from node/explorer API
     * @returns {Plan|null}
     */
    function parsePlanBox(box) {
        try {
            var regs = box.additionalRegisters || {};

            // Need R4, R5, R6 at minimum
            var r4Hex = regs.R4 || regs.r4;
            var r5Hex = regs.R5 || regs.r5;
            var r6Hex = regs.R6 || regs.r6;

            if (!r4Hex || !r5Hex || !r6Hex) return null;

            // Explorer may wrap in { serializedValue: "..." }
            if (typeof r4Hex === 'object') r4Hex = r4Hex.serializedValue || r4Hex.renderedValue;
            if (typeof r5Hex === 'object') r5Hex = r5Hex.serializedValue || r5Hex.renderedValue;
            if (typeof r6Hex === 'object') r6Hex = r6Hex.serializedValue || r6Hex.renderedValue;

            var name = decodePlanName(r4Hex);
            var pricePerDay = decodePricePerDay(r5Hex);
            var planId = decodePlanId(r6Hex);

            if (!name || planId <= 0 || pricePerDay <= 0n) return null;

            return {
                planId: planId,
                name: name,
                pricePerDay: pricePerDay,
                paymentAsset: '', // Empty = native ERG payment
            };
        } catch (e) {
            console.warn('parsePlanBox error:', e);
            return null;
        }
    }

    function decodeHexString(hex) {
        try {
            var bytes = hexToBytes(hex);
            return new TextDecoder().decode(bytes);
        } catch (_) {
            return hex;
        }
    }

    /**
     * Fetch active plans.
     *
     * Plans are stored as boxes at the server's address with specific register
     * layout. We query the subscription contract address or the deployer address
     * for unspent boxes and attempt to parse each as a plan.
     *
     * Strategy:
     * 1. Try node API: /blockchain/box/unspent/byErgoTree
     * 2. Fallback to explorer: /boxes/unspent/byErgoTree
     */
    async function loadPlans() {
        var sel = document.getElementById('plan-select');

        // We need the deployer/server address to find plan boxes
        var planAddress = CONFIG.serverAddress || CONFIG.deployerAddress;
        if (!planAddress) {
            sel.innerHTML = '<option value="">Server address not configured</option>';
            return;
        }

        try {
            var serverErgoTree = ergoTreeFromAddress(planAddress);
            var boxes = null;

            // Try node API first (via proxy)
            try {
                boxes = await nodeFetch(
                    '/blockchain/box/unspent/byErgoTree',
                    serverErgoTree
                );
            } catch (nodeErr) {
                console.warn('Node query failed, trying explorer:', nodeErr);
            }

            // Fallback to explorer
            if (!boxes || !Array.isArray(boxes)) {
                try {
                    var explorerResult = await explorerFetch(
                        '/boxes/unspent/byErgoTree/' + encodeURIComponent(serverErgoTree) + '?limit=50'
                    );
                    boxes = explorerResult ? (explorerResult.items || explorerResult) : [];
                } catch (explorerErr) {
                    console.warn('Explorer query also failed:', explorerErr);
                    boxes = [];
                }
            }

            if (!Array.isArray(boxes) || boxes.length === 0) {
                sel.innerHTML = '<option value="">No plans available</option>';
                return;
            }

            // Try parsing each box as a plan
            plans = [];
            for (var i = 0; i < boxes.length; i++) {
                var plan = parsePlanBox(boxes[i]);
                if (plan) plans.push(plan);
            }

            sel.innerHTML = '';
            if (plans.length === 0) {
                sel.innerHTML = '<option value="">No active plans found</option>';
                return;
            }

            for (var j = 0; j < plans.length; j++) {
                var opt = document.createElement('option');
                opt.value = String(plans[j].planId);
                opt.textContent = plans[j].name;
                sel.appendChild(opt);
            }

            // Enable plan selection now that we have data
            sel.disabled = false;
            updateCost();

        } catch (err) {
            console.error('loadPlans error:', err);
            sel.innerHTML = '<option value="">Error loading plans</option>';
        }
    }

    // ── Cost formatting ─────────────────────────────────────────────────

    /**
     * Format a token amount for display.
     *
     * @param {bigint} baseUnits - Amount in smallest denomination
     * @param {number} decimals  - Decimal places (9 for ERG, varies for tokens)
     * @param {string} symbol    - Display symbol ("ERG", token name, etc.)
     * @returns {string}
     */
    function formatAmount(baseUnits, decimals, symbol) {
        if (decimals === 0) return baseUnits.toLocaleString() + ' ' + symbol;

        var factor = BigInt(Math.pow(10, decimals));
        var whole = baseUnits / factor;
        var frac = baseUnits % factor;
        if (frac < 0n) frac = -frac;

        var fracStr = frac.toString().padStart(decimals, '0');
        var num = Number(whole.toString() + '.' + fracStr);

        // Smart decimal display
        var formatted;
        if (num >= 100) {
            formatted = Math.round(num).toLocaleString();
        } else if (num >= 1) {
            formatted = num.toFixed(2);
        } else if (num > 0) {
            var s = num.toFixed(decimals);
            var dotIdx = s.indexOf('.');
            var firstNonZero = -1;
            for (var i = dotIdx + 1; i < s.length; i++) {
                if (s[i] !== '0') { firstNonZero = i; break; }
            }
            if (firstNonZero === -1) {
                formatted = '0';
            } else {
                var sigDigits = Math.min(firstNonZero - dotIdx + 3, decimals);
                formatted = num.toFixed(sigDigits);
                formatted = formatted.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '.0');
            }
        } else {
            formatted = '0';
        }

        return formatted + ' ' + symbol;
    }

    /**
     * Get display info for a payment asset.
     * Returns { decimals, symbol }.
     */
    function getAssetDisplayInfo(paymentAsset) {
        // Empty = native ERG (nanoERG, 9 decimals)
        if (!paymentAsset || paymentAsset === '') {
            return { decimals: 9, symbol: 'ERG' };
        }
        // For tokens: we'd need to look up decimals; default to 0
        return { decimals: 0, symbol: paymentAsset.slice(0, 8) + '...' };
    }

    // ── Cost calculation ──────────────────────────────────────────────────

    function updateCost() {
        var planId = Number(document.getElementById('plan-select').value);
        var days = parseInt(document.getElementById('days-input').value, 10) || 0;
        var plan = plans.find(function (p) { return p.planId === planId; });
        var costEl = document.getElementById('total-cost');
        var detailEl = document.getElementById('plan-detail');

        if (plan && days > 0) {
            var total = plan.pricePerDay * BigInt(days);
            var info = getAssetDisplayInfo(plan.paymentAsset);
            costEl.textContent = formatAmount(total, info.decimals, info.symbol);
            detailEl.classList.add('hidden');
        } else {
            costEl.textContent = '-';
            detailEl.classList.add('hidden');
        }

        // Enable subscribe only when wallet connected + plan selected + days valid
        var btnSub = document.getElementById('btn-subscribe');
        btnSub.disabled = !(ergoCtx !== null && plan && days > 0);
    }

    document.getElementById('days-input').addEventListener('input', updateCost);
    document.getElementById('plan-select').addEventListener('change', updateCost);

    // ── UI helpers ────────────────────────────────────────────────────────

    function escapeHtml(str) {
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function showStatus(elementId, message, type) {
        var el = document.getElementById(elementId);
        if (!el) return;
        el.innerHTML = '<div class="status ' + (type || 'info') + '">' + message + '</div>';
    }

    function updateStep(stepNum, state) {
        var el = document.getElementById('step' + stepNum + '-num');
        if (!el) return;
        el.classList.remove('done', 'error');
        if (state === 'done') { el.classList.add('done'); el.textContent = '\u2713'; }
        else if (state === 'error') { el.classList.add('error'); el.textContent = '!'; }
        else { el.textContent = String(stepNum); }
    }

    // ── Step 3: Subscribe ─────────────────────────────────────────────────

    document.getElementById('btn-subscribe').addEventListener('click', async function () {
        var btn = document.getElementById('btn-subscribe');
        btn.disabled = true;
        btn.textContent = 'Working...';

        try {
            // Gather parameters
            var planId = Number(document.getElementById('plan-select').value);
            var days = parseInt(document.getElementById('days-input').value, 10);
            var plan = plans.find(function (p) { return p.planId === planId; });

            if (!plan) throw new Error('Please select a plan');
            if (!days || days < 1) throw new Error('Please enter a valid number of days');
            if (!ergoCtx) throw new Error('Wallet not connected');
            if (!CONFIG.serverPublicKey) throw new Error('Server public key not configured');
            if (!CONFIG.subscriptionErgoTree) throw new Error('Subscription contract not configured');

            // ── Step A: get encryption password ──────
            var subPassword = document.getElementById('subscribe-password') ? document.getElementById('subscribe-password').value : '';
            var subPasswordVerify = document.getElementById('subscribe-password-verify') ? document.getElementById('subscribe-password-verify').value : '';
            if (!subPassword) throw new Error('Please enter an encryption password');
            if (subPassword !== subPasswordVerify) throw new Error('Passwords do not match');

            // Derive key material: hex-encode publicSecret+password
            var combined = CONFIG.publicSecret + subPassword;
            var combinedHex = bytesToHex(new TextEncoder().encode(combined));

            // ── Step B: ECIES encrypt the key material with server pubkey
            showStatus('subscribe-status', '<span class="spinner"></span>Encrypting credentials...', 'info');

            var userEncryptedHex = await eciesEncrypt(CONFIG.serverPublicKey, combinedHex);
            console.log('userEncryptedHex length:', userEncryptedHex.length, 'bytes:', userEncryptedHex.length / 2);

            updateStep(3, 'done');
            showStatus('subscribe-status', '<span class="spinner"></span>Building subscription transaction...', 'info');

            // ── Step C: Build and submit subscription transaction ─────────
            //
            // Uses Fleet SDK TransactionBuilder for correct EIP-12 output format.
            // Register encoding uses Fleet SDK serializer (SPair, SInt, SLong, SColl, SByte).
            // All time references use block height, not timestamps.

            var F = window.Fleet;
            if (!F) throw new Error('Fleet SDK not loaded');

            // C.1  Compute subscription parameters (block-height based)
            var totalPayment = plan.pricePerDay * BigInt(days);
            var blocksPerDay = 720;
            var intervalBlocks = blocksPerDay; // 1 day in blocks (~2 min/block)
            var ratePerInterval = plan.pricePerDay;

            // C.2  Get wallet UTXOs and current height
            showStatus('subscribe-status', '<span class="spinner"></span>Fetching UTXOs...', 'info');

            var height = await ergoCtx.get_current_height();
            var utxos = await ergoCtx.get_utxos();
            var changeAddr = await ergoCtx.get_change_address();

            if (!utxos || utxos.length === 0) {
                throw new Error('No UTXOs in wallet -- fund your wallet first');
            }

            var lastCollectedHeight = height;
            var expiryHeight = height + days * blocksPerDay;

            // C.3  Parse payment asset from plan
            var paymentTokenId = plan.paymentAsset || '';
            var isErgPayment = !paymentTokenId;

            // C.4  Compute the subscription box value
            var subscriptionBoxValue;
            if (isErgPayment) {
                subscriptionBoxValue = totalPayment;
            } else {
                subscriptionBoxValue = F.SAFE_MIN_BOX_VALUE;
            }

            // C.5  Encode subscription registers using Fleet SDK serializer
            //   R4: (Int, Coll[Byte])        — (planId, subscriberErgoTree)
            //   R5: (Long, (Long, Int))       — (amountRemaining, (ratePerInterval, intervalBlocks))
            //   R6: (Int, Int)               — (lastCollectedHeight, expiryHeight)
            //   R7: Coll[Byte]               — paymentTokenId (empty for ERG)
            //   R8: Coll[Byte]               — userEncrypted
            var subscriberETBytes = F.hex.decode(connectedErgoTree);
            var r4Hex = F.SPair(F.SInt(planId), F.SColl(F.SByte, subscriberETBytes)).toHex();
            var r5Hex = F.SPair(F.SLong(totalPayment), F.SPair(F.SLong(ratePerInterval), F.SInt(intervalBlocks))).toHex();
            var r6Hex = F.SPair(F.SInt(lastCollectedHeight), F.SInt(expiryHeight)).toHex();
            var r7Bytes = paymentTokenId ? F.hex.decode(paymentTokenId) : new Uint8Array(0);
            var r7Hex = F.SColl(F.SByte, r7Bytes).toHex();
            var r8Bytes = userEncryptedHex ? F.hex.decode(userEncryptedHex) : new Uint8Array(0);
            var r8Hex = F.SColl(F.SByte, r8Bytes).toHex();

            console.log('R4:', r4Hex.slice(0, 40) + '...');
            console.log('R5:', r5Hex);
            console.log('R6:', r6Hex);
            console.log('R7:', r7Hex.slice(0, 20) + '...');
            console.log('R8:', r8Hex.slice(0, 40) + '...');

            // C.6  Build the subscription output using Fleet SDK OutputBuilder
            showStatus('subscribe-status', '<span class="spinner"></span>Building transaction...', 'info');

            var subOutput = new F.OutputBuilder(subscriptionBoxValue, CONFIG.subscriptionErgoTree)
                .mintToken({ amount: 1n })  // beacon token (ID = first input boxId)
                .setAdditionalRegisters({ R4: r4Hex, R5: r5Hex, R6: r6Hex, R7: r7Hex, R8: r8Hex });

            // C.7  Token payment: add payment token to subscription box
            if (!isErgPayment) {
                subOutput.addTokens({ tokenId: paymentTokenId, amount: totalPayment });
            }

            // C.8  Build transaction with Fleet SDK TransactionBuilder
            var txBuilder = new F.TransactionBuilder(height)
                .from(utxos)
                .to(subOutput);

            // C.9  Optional deployer fee output
            if (CONFIG.deployerAddress) {
                txBuilder.to(new F.OutputBuilder('2500000', CONFIG.deployerAddress));
            }

            var unsignedTx = txBuilder
                .sendChangeTo(changeAddr)
                .payMinFee()
                .build();

            var eip12Tx = unsignedTx.toEIP12Object();
            var beaconTokenId = utxos[0].boxId;

            console.log('EIP-12 tx inputs:', eip12Tx.inputs.length, 'outputs:', eip12Tx.outputs.length);
            console.log('Beacon token ID:', beaconTokenId);

            // C.10 Sign via Nautilus (EIP-12)
            showStatus('subscribe-status', '<span class="spinner"></span>Awaiting wallet signature...', 'info');
            var signedTx = await ergoCtx.sign_tx(eip12Tx);

            // C.13 Submit via Nautilus
            showStatus('subscribe-status', '<span class="spinner"></span>Submitting transaction...', 'info');
            var txId = await ergoCtx.submit_tx(signedTx);

            console.log('Transaction submitted:', txId);

            // Show success
            var explorerTxUrl = CONFIG.network === 'mainnet'
                ? 'https://explorer.ergoplatform.com/en/transactions/'
                : 'https://testnet.ergoplatform.com/en/transactions/';
            document.getElementById('result-card').classList.remove('hidden');
            document.getElementById('result-content').innerHTML =
                'Transaction submitted successfully!<br>' +
                'Beacon token: <code>' + beaconTokenId.slice(0, 16) + '...</code><br>' +
                '<a class="tx-link" href="' + explorerTxUrl + txId + '" target="_blank" rel="noopener">' +
                txId + '</a>';

            showStatus('subscribe-status', 'Subscription created! Your server will be provisioned shortly.', 'success');

        } catch (err) {
            console.error('subscribe error:', err);
            showStatus('subscribe-status', escapeHtml(err.message || 'Subscription failed'), 'error');
            updateStep(3, 'error');
            btn.disabled = false;
            btn.textContent = 'Subscribe';
        }
    });

    // ── Tab switching ─────────────────────────────────────────────────────

    window.switchTab = function (tab) {
        document.getElementById('tab-wallet').classList.toggle('active', tab === 'wallet');
        document.getElementById('tab-offline').classList.toggle('active', tab === 'offline');
        document.getElementById('mode-wallet').classList.toggle('hidden', tab !== 'wallet');
        document.getElementById('mode-offline').classList.toggle('hidden', tab !== 'offline');
    };

    // ── NFT loading (wallet mode) ───────────────────────────────────────
    //
    // On Ergo, access NFTs are standard tokens minted during subscription creation.
    // The server mints an NFT and stores connection info encrypted in a reference box.
    // The user holds the NFT; the reference box is at the server's address.

    var userNfts = [];
    var selectedNft = null;

    /**
     * Load access NFTs held by the connected wallet.
     * Queries the explorer for tokens matching the NFT token prefix or
     * known NFT identifiers associated with this BlockHost instance.
     */
    async function loadUserNfts() {
        if (!connectedAddress || !ergoCtx) return;

        document.getElementById('servers-not-connected').classList.add('hidden');
        document.getElementById('servers-loading').classList.remove('hidden');
        document.getElementById('server-list').classList.add('hidden');
        document.getElementById('servers-empty').classList.add('hidden');
        document.getElementById('servers-decrypt').classList.add('hidden');
        document.getElementById('connection-result').classList.add('hidden');

        try {
            // Get wallet's token balance via explorer
            var balance = await explorerFetch('/addresses/' + connectedAddress + '/balance/confirmed');
            if (!balance) {
                document.getElementById('servers-loading').classList.add('hidden');
                document.getElementById('servers-empty').classList.remove('hidden');
                return;
            }

            var tokens = balance.tokens || [];
            userNfts = [];

            // Look for tokens that match our NFT pattern
            // Access NFTs are tokens with amount=1 minted by the subscription handler
            for (var i = 0; i < tokens.length; i++) {
                var token = tokens[i];
                if (token.amount === 1 || token.amount === '1') {
                    // Potential access NFT; look up its metadata
                    try {
                        var tokenInfo = await explorerFetch('/tokens/' + token.tokenId);
                        if (tokenInfo && tokenInfo.name && tokenInfo.name.indexOf('BlockHost') !== -1) {
                            userNfts.push({
                                tokenId: token.tokenId,
                                name: tokenInfo.name || ('Server ' + token.tokenId.slice(0, 8)),
                            });
                        }
                    } catch (tokenErr) {
                        // Not an access NFT, skip
                    }
                }
            }

            // If no explicitly named NFTs found, show all single-quantity tokens
            // as potential access NFTs (the user can try decrypting)
            if (userNfts.length === 0) {
                for (var i = 0; i < tokens.length; i++) {
                    if (tokens[i].amount === 1 || tokens[i].amount === '1') {
                        userNfts.push({
                            tokenId: tokens[i].tokenId,
                            name: tokens[i].name || ('Token ' + tokens[i].tokenId.slice(0, 8)),
                        });
                    }
                }
            }

            document.getElementById('servers-loading').classList.add('hidden');

            if (userNfts.length > 0) {
                document.getElementById('server-list').classList.remove('hidden');
                renderNftList();
            } else {
                document.getElementById('servers-empty').classList.remove('hidden');
            }
        } catch (err) {
            console.error('Error loading NFTs:', err);
            document.getElementById('servers-loading').classList.add('hidden');
            document.getElementById('servers-empty').classList.remove('hidden');
            document.getElementById('servers-empty').innerHTML =
                '<p class="step-desc">Error loading NFTs: ' + escapeHtml(err.message || err) + '</p>';
        }
    }

    function renderNftList() {
        var container = document.getElementById('server-list');
        container.innerHTML = '';
        userNfts.forEach(function (nft, index) {
            var card = document.createElement('div');
            card.className = 'server-card' + (index === 0 ? ' selected' : '');
            card.innerHTML =
                '<div class="server-card-header">' +
                    '<span class="server-card-title">' + escapeHtml(nft.name) + '</span>' +
                    '<span class="server-card-id">' + nft.tokenId.slice(0, 12) + '...</span>' +
                '</div>';
            card.addEventListener('click', function () { selectNft(index); });
            container.appendChild(card);
        });
        if (userNfts.length > 0) selectNft(0);
    }

    function selectNft(index) {
        selectedNft = userNfts[index];
        document.querySelectorAll('.server-card').forEach(function (card, i) {
            card.classList.toggle('selected', i === index);
        });
        document.getElementById('servers-decrypt').classList.remove('hidden');
        document.getElementById('connection-result').classList.add('hidden');
        document.getElementById('decrypt-wallet-status').innerHTML = '';
    }

    /**
     * Fetch the userEncrypted field from a reference box.
     *
     * On Ergo, the reference box is at the server's address and contains
     * the encrypted connection details in its registers. The reference box
     * is identified by holding a reference token associated with the access NFT.
     *
     * Approach: find boxes at the server address that have R8 register data
     * and match the token pattern.
     *
     * @param {string} nftTokenId - The access NFT token ID
     * @returns {Promise<string|null>} Hex-encoded encrypted data or null
     */
    async function fetchUserEncrypted(nftTokenId) {
        try {
            // Look for the reference box by querying boxes that hold this token
            var boxes = await explorerFetch('/boxes/unspent/byTokenId/' + nftTokenId);
            if (!boxes) return null;

            var boxList = boxes.items || boxes;
            if (!Array.isArray(boxList)) return null;

            for (var i = 0; i < boxList.length; i++) {
                var box = boxList[i];
                var regs = box.additionalRegisters || {};

                // Look for R8 (userEncrypted) — that is the encrypted connection data
                var r8 = regs.R8 || regs.r8;
                if (r8) {
                    if (typeof r8 === 'object') r8 = r8.serializedValue || r8.renderedValue;
                    if (r8 && r8.length > 10) {
                        // Decode the SColl[SByte] to get raw encrypted hex
                        var encBytes = sigmaDecodeCollByte(r8);
                        if (encBytes.length > 0) return bytesToHex(encBytes);
                    }
                }
            }

            // Also check for EIP-4 style NFT data where encrypted info
            // might be in a different register
            return null;
        } catch (err) {
            console.error('fetchUserEncrypted error:', err);
            return null;
        }
    }

    // ── Decrypt (wallet mode) ───────────────────────────────────────────

    var btnDecryptWallet = document.getElementById('btn-decrypt-wallet');
    if (btnDecryptWallet) btnDecryptWallet.addEventListener('click', async function () {
        if (!selectedNft) return;

        var btn = document.getElementById('btn-decrypt-wallet');
        var statusEl = document.getElementById('decrypt-wallet-status');

        try {
            btn.disabled = true;

            var decryptPw = document.getElementById('decrypt-password') ? document.getElementById('decrypt-password').value : '';
            if (!decryptPw) throw new Error('Please enter your encryption password');

            showStatus('decrypt-wallet-status', '<span class="spinner"></span>Fetching NFT data...', 'info');
            var userEncHex = await fetchUserEncrypted(selectedNft.tokenId);
            if (!userEncHex) throw new Error('No encrypted data found for token ' + selectedNft.tokenId.slice(0, 16) + '...');

            showStatus('decrypt-wallet-status', '<span class="spinner"></span>Decrypting...', 'info');

            // Derive key: SHAKE256(publicSecret + password)
            var combined = CONFIG.publicSecret + decryptPw;
            var combinedBytes = new TextEncoder().encode(combined);
            await ensureShake256();
            var keyBytes = deriveSymmetricKey(combinedBytes);
            var decrypted = await decryptAesGcm(keyBytes, userEncHex);

            document.getElementById('connection-info').textContent = decrypted;
            document.getElementById('connection-result').classList.remove('hidden');
            statusEl.innerHTML = '';

        } catch (err) {
            console.error('Decrypt error:', err);
            showStatus('decrypt-wallet-status', escapeHtml(err.message || 'Decryption failed'), 'error');
        } finally {
            btn.disabled = false;
        }
    });

    // ── NFT lookup (offline mode) ───────────────────────────────────────

    var btnLookupNft = document.getElementById('btn-lookup-nft');
    if (btnLookupNft) btnLookupNft.addEventListener('click', async function () {
        var statusEl = document.getElementById('offline-lookup-status');
        var btn = document.getElementById('btn-lookup-nft');

        var tokenId = document.getElementById('offline-token-id').value.trim();
        if (!tokenId) {
            showStatus('offline-lookup-status', 'Please enter a token ID (64 hex chars)', 'error');
            return;
        }

        try {
            btn.disabled = true;
            showStatus('offline-lookup-status', '<span class="spinner"></span>Querying token on-chain...', 'info');

            var userEncHex = await fetchUserEncrypted(tokenId);
            if (!userEncHex) {
                showStatus('offline-lookup-status', 'No encrypted data found for token ' + tokenId.slice(0, 16) + '...', 'error');
                return;
            }

            window._offlineNftData = { tokenId: tokenId, userEncrypted: userEncHex };

            showStatus('offline-lookup-status',
                'Found encrypted data for token (' + userEncHex.length + ' hex chars).', 'success');

            document.getElementById('offline-public-secret').textContent = CONFIG.publicSecret;
            document.getElementById('offline-encrypted-data').textContent = userEncHex;
            document.getElementById('offline-cli-instructions').innerHTML =
                'Enter the encryption password you set when subscribing to decrypt your connection details.';
            document.getElementById('offline-nft-info').classList.remove('hidden');
        } catch (err) {
            console.error('NFT lookup error:', err);
            showStatus('offline-lookup-status', 'Lookup failed: ' + escapeHtml(err.message || err), 'error');
        } finally {
            btn.disabled = false;
        }
    });

    // ── Decrypt (offline mode) ──────────────────────────────────────────

    var btnDecryptOffline = document.getElementById('btn-decrypt-offline');
    if (btnDecryptOffline) btnDecryptOffline.addEventListener('click', async function () {
        var statusEl = document.getElementById('decrypt-offline-status');
        var offlinePw = document.getElementById('offline-password') ? document.getElementById('offline-password').value : '';

        if (!offlinePw) {
            showStatus('decrypt-offline-status', 'Please enter your encryption password', 'error');
            return;
        }
        if (!window._offlineNftData) {
            showStatus('decrypt-offline-status', 'Please lookup a token first', 'error');
            return;
        }

        try {
            showStatus('decrypt-offline-status', '<span class="spinner"></span>Decrypting...', 'info');
            await ensureShake256();
            var combined = CONFIG.publicSecret + offlinePw;
            var combinedBytes = new TextEncoder().encode(combined);
            var keyBytes = deriveSymmetricKey(combinedBytes);
            var decrypted = await decryptAesGcm(keyBytes, window._offlineNftData.userEncrypted);

            document.getElementById('offline-connection-info').textContent = decrypted;
            document.getElementById('offline-connection-result').classList.remove('hidden');
            statusEl.innerHTML = '';
        } catch (err) {
            console.error('Decrypt error:', err);
            showStatus('decrypt-offline-status', 'Decryption failed. Wrong password or corrupted data.', 'error');
        }
    });

    // ── Admin Commands ───────────────────────────────────────────────────
    //
    // Protocol: transaction output with R4 register data
    // Payload: UTF-8("{nonce} {command}") + HMAC-SHA256(sharedKey, message)[:16]
    // SharedKey: SHAKE256(signature of publicSecret)
    //
    // The command is submitted as an Ergo transaction with an output box
    // at the admin address containing the HMAC-authenticated command in R4.
    // The server scans admin wallet transactions for R4 register data.

    var _adminNonce = (function () {
        var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        var nonce = '';
        var rand = crypto.getRandomValues(new Uint8Array(3));
        for (var i = 0; i < 3; i++) nonce += chars[rand[i] % chars.length];
        return nonce;
    })();

    var btnSendCommand = document.getElementById('btn-send-command');
    if (btnSendCommand) btnSendCommand.addEventListener('click', async function () {
        var btn = document.getElementById('btn-send-command');
        var statusEl = document.getElementById('command-status');
        var commandInput = document.getElementById('command-input').value.trim();

        if (!commandInput) {
            showStatus('command-status', 'Please enter a command', 'error');
            return;
        }
        if (!ergoCtx) {
            showStatus('command-status', 'Please connect your wallet first', 'error');
            return;
        }

        try {
            btn.disabled = true;

            var message = _adminNonce + ' ' + commandInput;

            // Sign publicSecret to derive shared key
            showStatus('command-status', '<span class="spinner"></span>Sign the message in your wallet...', 'info');
            var signResult = await ergoCtx.sign_data(connectedAddress, CONFIG.publicSecret);

            var rawSig;
            if (typeof signResult === 'string') {
                rawSig = signResult;
            } else if (signResult && signResult.signedMessage) {
                rawSig = signResult.signedMessage;
            } else if (signResult && signResult.proof) {
                rawSig = signResult.proof;
            } else {
                rawSig = bytesToHex(new TextEncoder().encode(JSON.stringify(signResult)));
            }

            await ensureShake256();
            var sharedKey = deriveSymmetricKey(hexToBytes(rawSig));

            // Compute HMAC-SHA256(sharedKey, message)[:16]
            showStatus('command-status', '<span class="spinner"></span>Computing HMAC...', 'info');
            var cryptoKey = await crypto.subtle.importKey(
                'raw', sharedKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
            var messageBytes = new TextEncoder().encode(message);
            var hmacFull = await crypto.subtle.sign('HMAC', cryptoKey, messageBytes);
            var hmac16 = new Uint8Array(hmacFull).slice(0, 16);

            // Build payload: message_bytes + hmac_suffix(16)
            var payload = new Uint8Array(messageBytes.length + 16);
            payload.set(messageBytes, 0);
            payload.set(hmac16, messageBytes.length);

            var payloadHex = bytesToHex(payload);

            console.log('Admin command payload:', message, '(' + payload.length + ' bytes)');

            // Build and submit the admin command transaction
            showStatus('command-status', '<span class="spinner"></span>Building command transaction...', 'info');

            var height = await ergoCtx.get_current_height();
            var utxos = await ergoCtx.get_utxos();
            var changeAddr = await ergoCtx.get_change_address();

            if (!utxos || utxos.length === 0) {
                throw new Error('No UTXOs in wallet');
            }

            // Build command output box with payload in R4 using Fleet SDK
            var F = window.Fleet;
            if (!F) throw new Error('Fleet SDK not loaded');

            var adminAddr = CONFIG.adminAddress || changeAddr;
            var r4Payload = F.SColl(F.SByte, hexToBytes(payloadHex)).toHex();

            var cmdOutput = new F.OutputBuilder(F.SAFE_MIN_BOX_VALUE, adminAddr)
                .setAdditionalRegisters({ R4: r4Payload });

            var unsignedTx = new F.TransactionBuilder(height)
                .from(utxos)
                .to(cmdOutput)
                .sendChangeTo(changeAddr)
                .payMinFee()
                .build();

            var eip12Tx = unsignedTx.toEIP12Object();

            showStatus('command-status', '<span class="spinner"></span>Awaiting wallet signature...', 'info');
            var signedTx = await ergoCtx.sign_tx(eip12Tx);

            showStatus('command-status', '<span class="spinner"></span>Submitting...', 'info');
            var txId = await ergoCtx.submit_tx(signedTx);

            console.log('Admin command tx:', txId);

            document.getElementById('command-result').classList.remove('hidden');
            document.getElementById('command-tx-info').innerHTML =
                'Transaction: <a class="tx-link" href="' +
                (CONFIG.network === 'mainnet'
                    ? 'https://explorer.ergoplatform.com/en/transactions/'
                    : 'https://testnet.ergoplatform.com/en/transactions/') +
                txId + '" target="_blank" rel="noopener">' + txId + '</a>';

            showStatus('command-status', 'Command sent successfully!', 'success');

            // Rotate nonce for next command
            _adminNonce = (function () {
                var chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
                var nonce = '';
                var rand = crypto.getRandomValues(new Uint8Array(3));
                for (var i = 0; i < 3; i++) nonce += chars[rand[i] % chars.length];
                return nonce;
            })();

        } catch (err) {
            console.error('Command error:', err);
            showStatus('command-status', escapeHtml(err.message || 'Failed to send command'), 'error');
        } finally {
            btn.disabled = false;
        }
    });

    // ── Initialise ────────────────────────────────────────────────────────

    // Wallet extensions inject window.ergoConnector asynchronously after page load.
    // Retry detection a few times with increasing delays.
    function detectWithRetry(attempt) {
        if (attempt > 5) return; // give up after ~3 seconds
        if (window.ergoConnector && typeof window.ergoConnector === 'object' && Object.keys(window.ergoConnector).length > 0) {
            detectWallets();
        } else {
            setTimeout(function () { detectWithRetry(attempt + 1); }, 300 * attempt);
        }
    }

    // Try immediately, then retry
    if (document.readyState === 'complete') {
        detectWithRetry(0);
    } else {
        window.addEventListener('load', function () { detectWithRetry(0); });
    }

    // Start fetching plans in the background (may show before wallet connects)
    loadPlans();

    console.log('BlockHost signup engine (Ergo) loaded');
    console.log('  network:', CONFIG.network);
    console.log('  subscriptionErgoTree:', CONFIG.subscriptionErgoTree ? CONFIG.subscriptionErgoTree.slice(0, 16) + '...' : 'NOT SET');
    console.log('  serverPublicKey:', CONFIG.serverPublicKey ? CONFIG.serverPublicKey.slice(0, 16) + '...' : 'NOT SET');
    console.log('  serverAddress:', CONFIG.serverAddress || 'NOT SET');

})();
