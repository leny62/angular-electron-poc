#!/usr/bin/env node
const { pbkdf2Sync, createHash } = require('crypto');
const os = require('os');
const { execSync } = require('child_process');

const PASSPHRASE = 'bizuri-poc-dev-key-2026';
const PEPPER = 'bizuri-poc-v1.0.0';
const APP_DATA = `${os.homedir()}/Library/Application Support/bizuri-poc`;

function getSaltFromKeychain() {
  try {
    const hex = execSync(
      'security find-generic-password -a machine-salt -s com.bizuri.electron-poc -w',
      { stdio: ['ignore', 'pipe', 'ignore'] },
    ).toString().trim();
    if (hex.length === 64) {
      return { salt: Buffer.from(hex, 'hex'), source: 'keychain' };
    }
  } catch {}
  return null;
}

function getSaltFromFingerprint() {
  const hostname = os.hostname();
  const cpuModel = os.cpus()[0]?.model ?? 'unknown-cpu';
  const canonical = `${hostname}|${cpuModel}|${APP_DATA}|${PEPPER}`;
  return {
    salt: createHash('sha256').update(canonical, 'utf8').digest(),
    source: 'fingerprint',
  };
}

const keychainResult = getSaltFromKeychain();
const { salt, source } = keychainResult ?? getSaltFromFingerprint();

const key = pbkdf2Sync(PASSPHRASE, salt, 600_000, 32, 'sha256');
const hex = key.toString('hex');

console.log(`Salt source: ${source}`);
console.log(`DB path:     ${APP_DATA}/bizuri-poc.db`);
console.log(`Hex key:     ${hex}`);
console.log('');
console.log('TablePlus:');
console.log('  1. File > New > SQLite');
console.log('  2. Database Type: SQLCipher');
console.log('  3. Database: ' + APP_DATA + '/bizuri-poc.db');
console.log('  4. Cipher Version: 4 (default)');
console.log('  5. Key: paste the hex key above');
console.log('  6. KDF: none (the key is already derived)');
