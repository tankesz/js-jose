/**
 * Generates an IV.
 * This function mainly exists so that it can be mocked for testing purpose.
 *
 * @return Uint8Array with random bytes
 */
JoseJWE.prototype.createIV = function() {
	var iv = new Uint8Array(new Array(this.content_encryption.iv_length));	
	return crypto.getRandomValues(iv);
};

/**
 * Creates a random content encryption key.
 * This function mainly exists so that it can be mocked for testing purpose.
 *
 * @return Promise<CryptoKey>
 */
JoseJWE.prototype.createCEK = function(purpose) {
	return crypto.subtle.generateKey(this.content_encryption.id, true, purpose);
};

/**
 * Performs encryption
 *
 * @param key_promise  Promise<CryptoKey>, either RSA or shared key
 * @param plain_text   string to encrypt
 * @return Promise<string>
 */
JoseJWE.prototype.encrypt = function(key_promise, plain_text) {
	// Create a CEK key
	var cek_promise = this.createCEK(["encrypt"]);

	// Key & Cek allows us to create the encrypted_cek
	var encrypted_cek = this.encryptCek(key_promise, cek_promise);

	// Cek allows us to encrypy the plaintext
	var enc_promise = this.encryptPlaintext(cek_promise, plain_text);

	// Once we have all the promises, we can base64 encode all the pieces.
	return Promise.all([encrypted_cek, enc_promise]).then(function(all) {
		var encrypted_cek = all[0];
		var data = all[1];
		return data.header + "." +
			JoseJWE.Utils.Base64Url.encodeArrayBuffer(encrypted_cek) + "." +
			JoseJWE.Utils.Base64Url.encodeArrayBuffer(data.iv.buffer) + "." +
			JoseJWE.Utils.Base64Url.encodeArrayBuffer(data.cipher) + "." +
			JoseJWE.Utils.Base64Url.encodeArrayBuffer(data.tag);
	});
};

/**
 * Encrypts the CEK
 *
 * @param key_promise  Promise<CryptoKey>
 * @param cek_promise  Promise<CryptoKey>
 * @return Promise<ArrayBuffer>
 */
JoseJWE.prototype.encryptCek = function(key_promise, cek_promise) {
	var config = this.key_encryption;
	return Promise.all([key_promise, cek_promise]).then(function(all) {
		var key = all[0];
		var cek = all[1];
		return crypto.subtle.wrapKey("raw", cek, key, config.id);
	});
};

/**
 * Encrypts plain_text with CEK.
 *
 * @param cek_promise  Promise<CryptoKey>
 * @param plain_text   string
 * @return Promise<json>
 */
JoseJWE.prototype.encryptPlaintext = function(cek_promise, plain_text) {
	// Create header
	var jwe_protected_header = JoseJWE.Utils.Base64Url.encode(JSON.stringify({
		"alg": this.key_encryption.jwe_name,
		"enc": this.content_encryption.jwe_name
	}))

	// Create the IV
	var iv = this.createIV();
	if (iv.length != this.content_encryption.iv_length) {
		return Promise.reject("encryptPlaintext: invalid IV length");
	}

	// Create the AAD
	var aad = JoseJWE.Utils.arrayFromString(jwe_protected_header);
	var plain_text = JoseJWE.Utils.arrayFromString(plain_text);	

	var config = this.content_encryption;
	if (config.auth.aead) {
		var tag_length = config.auth.tag_length;
		if (tag_length % 8 != 0) {
			return Promise.reject("encryptPlaintext: invalid tag_length");
		}

		var enc = {
			name: config.id.name,
			iv: iv,
			additionalData: aad,
			tagLength: tag_length
		};

		return cek_promise.then(function(cek) {
			return crypto.subtle.encrypt(enc, cek, plain_text).then(function(cipher_text) {
				var offset = cipher_text.byteLength - tag_length/8;
				return {
					header: jwe_protected_header,
					iv: iv,
					cipher: cipher_text.slice(0, offset),
					tag: cipher_text.slice(offset)
				}
			});
		});
	} else {
		if (config.auth.truncated_length % 8 != 0) {
			return Promise.reject("encryptPlaintext: invalid truncated HMAC length");
		}

		// We need to split the CEK key into a MAC and ENC keys
		var cek_bytes_promise = cek_promise.then(function(cek) {
			return crypto.subtle.exportKey("raw", cek);
		});
		var mac_key_promise = cek_bytes_promise.then(function(cek_bytes) {
			if (cek_bytes.byteLength * 8 != config.id.length + config.auth.key_size) {
				return Promise.reject("encryptPlaintext: incorrect cek length");
			}
			var bytes = cek_bytes.slice(0, config.auth.key_size/8);
			return crypto.subtle.importKey("raw", bytes, config.auth.id, false, ["sign"]);			
		});
		var enc_key_promise = cek_bytes_promise.then(function(cek_bytes) {
			if (cek_bytes.byteLength * 8 != config.id.length + config.auth.key_size) {
				return Promise.reject("encryptPlaintext: incorrect cek length");
			}
			var bytes = cek_bytes.slice(config.auth.key_size/8);
			return crypto.subtle.importKey("raw", bytes, config.id, false, ["encrypt"]);
		});

		// Encrypt the plaintext
		var cipher_text_promise = enc_key_promise.then(function(enc_key) {
			var enc = {
				name: config.id.name,
				iv: iv,
			};
			return crypto.subtle.encrypt(enc, enc_key, plain_text)
		});

		// MAC the aad, iv and ciphertext
		var mac_promise = Promise.all([mac_key_promise, cipher_text_promise]).then(function(all) {
			var mac_key = all[0];
			var cipher_text = all[1];
			var al = new Uint8Array(JoseJWE.Utils.arrayFromInt32(aad.length * 8));
			var al_bigendian = new Uint8Array(8);
			for (var i=0; i<4; i++) {
				al_bigendian[7-i] = al[i];
			}
			var buf = JoseJWE.Utils.arrayBufferConcat(aad.buffer, iv.buffer, cipher_text, al_bigendian.buffer);
			return crypto.subtle.sign(config.auth.id, mac_key, buf)
		});

		return Promise.all([cipher_text_promise, mac_promise]).then(function(all) {
			var cipher_text = all[0];
			var mac = all[1];
			return {
				header: jwe_protected_header,
				iv: iv,
				cipher: cipher_text,
				tag: mac.slice(0, config.auth.truncated_length/8)
			}
		});
	}
};