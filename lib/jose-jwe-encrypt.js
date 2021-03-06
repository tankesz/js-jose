/* -
 * Copyright 2014 Square Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import * as Utils from './jose-utils';

/**
 * Handles encryption.
 *
 * @param cryptographer  an instance of WebCryptographer (or equivalent).
 * @param keyPromise    Promise<CryptoKey>, either RSA or shared key
 */
export class Encrypter {
  constructor (cryptographer, keyPromise) {
    this.cryptographer = cryptographer;
    this.keyPromise = keyPromise;
    this.userHeaders = {};
  }

  /**
   * Adds a key/value pair which will be included in the header.
   *
   * The data lives in plaintext (an attacker can read the header) but is tamper
   * proof (an attacker cannot modify the header).
   *
   * Note: some headers have semantic implications. E.g. if you set the "zip"
   * header, you are responsible for properly compressing plainText before
   * calling encrypt().
   *
   * @param k  String
   * @param v  String
   */
  addHeader (k, v) {
    this.userHeaders[k] = v;
  }

  /**
   * Performs encryption.
   *
   * @param uint8Array  Uint8Array
   * @param presetCEK CryptoKey
   * @return Promise<String>
   */
  encrypt (uint8Array, presetCEK) {
    /**
     * Encrypts plainText with CEK.
     *
     * @param cekPromise  Promise<CryptoKey>
     * @param uint8Array   Uint8Array
     * @return Promise<json>
     */
    var encryptPlainText = function (cekPromise, uint8Array) {
      // Create header
      var headers = {};
      for (var i in this.userHeaders) {
        headers[i] = this.userHeaders[i];
      }
      headers.alg = this.cryptographer.getKeyEncryptionAlgorithm();
      headers.enc = this.cryptographer.getContentEncryptionAlgorithm();
      var jweProtectedHeader = new Utils.Base64Url().encode(JSON.stringify(headers));

      // Create the IV
      var iv = this.cryptographer.createIV();

      // Create the AAD
      var aad = Utils.arrayFromString(jweProtectedHeader);

      var encryptPomise = this.cryptographer.encrypt(iv, aad, cekPromise, uint8Array);
      return encryptPomise.then(function (r) {
        r.header = jweProtectedHeader;
        r.iv = iv;
        return r;
      });
    };

    var cekPromise, encryptedCek;

    if (this.cryptographer.getKeyEncryptionAlgorithm() === 'dir') {
      // with direct encryption, this.keyPromise provides the cek
      // and encryptedCek is empty
      cekPromise = Promise.resolve(this.keyPromise);
      encryptedCek = [];
    } else {
      if (presetCEK === undefined) {
        // Create a CEK key
        console.debug('generating CEK');
        cekPromise = this.cryptographer.createCek();
        console.debug('cekPromise:' + cekPromise);
      } else {
        console.debug('using presetCEK');
        cekPromise = presetCEK;
        console.debug('cekPromise:' + cekPromise);
      }

      // Key & Cek allows us to create the encryptedCek
      encryptedCek = Promise.all([this.keyPromise, cekPromise]).then(function (all) {
        var key = all[0];
        var cek = all[1];
        return this.cryptographer.wrapCek(cek, key);
      }.bind(this));
    }

    // Cek allows us to encrypy the plain text
    var encPromise = encryptPlainText.bind(this, cekPromise, uint8Array)();

    // Once we have all the promises, we can base64 encode all the pieces.
    return Promise.all([encryptedCek, encPromise]).then(function (all) {
      var encryptedCek = all[0];
      var data = all[1];
      var base64UrlEncoder = new Utils.Base64Url();
      return data.header + '.' +
          base64UrlEncoder.encodeArray(encryptedCek) + '.' +
          base64UrlEncoder.encodeArray(data.iv) + '.' +
          base64UrlEncoder.encodeArray(data.cipher) + '.' +
          base64UrlEncoder.encodeArray(data.tag);
    });
  }

  /**
   * Performs plain text encryption.
   *
   * @param plainText  utf-8 string
   * @param presetCEK CryptoKey
   * @return Promise<String>
   */
  encryptPlainText (plainText, presetCEK) {
    const uint8Array = Utils.arrayFromUtf8String(plainText);
    return this.encrypt(uint8Array, presetCEK);
  }
}
