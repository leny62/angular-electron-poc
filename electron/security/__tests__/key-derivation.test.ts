import {
  deriveFromPassphrase,
  deriveFromSecrets,
  getMachineFingerprint,
  generateMachineSalt,
  zeroBuffer,
  keyToHex,
} from '../key-derivation';

describe('key derivation', () => {
  describe('deriveFromPassphrase', () => {
    it('produces a 32-byte key', () => {
      const km = deriveFromPassphrase('test-passphrase');
      expect(km.key).toHaveLength(32);
    });

    it('is deterministic for the same passphrase', () => {
      const a = deriveFromPassphrase('hello');
      const b = deriveFromPassphrase('hello');
      expect(a.key.equals(b.key)).toBe(true);
    });

    it('produces different keys for different passphrases', () => {
      const a = deriveFromPassphrase('alpha');
      const b = deriveFromPassphrase('beta');
      expect(a.key.equals(b.key)).toBe(false);
    });

    it('reports source as plaintext-sha256', () => {
      const km = deriveFromPassphrase('test');
      expect(km.source).toBe('plaintext-sha256');
    });
  });

  describe('deriveFromSecrets', () => {
    it('produces a 32-byte key', () => {
      const salt = generateMachineSalt();
      const km = deriveFromSecrets('passphrase', salt);
      expect(km.key).toHaveLength(32);
    });

    it('is deterministic for the same passphrase and salt', () => {
      const salt = generateMachineSalt();
      const a = deriveFromSecrets('secure-phrase', salt);
      const b = deriveFromSecrets('secure-phrase', salt);
      expect(a.key.equals(b.key)).toBe(true);
    });

    it('produces different keys for different salts', () => {
      const salt1 = generateMachineSalt();
      const salt2 = generateMachineSalt();
      const a = deriveFromSecrets('same-phrase', salt1);
      const b = deriveFromSecrets('same-phrase', salt2);
      expect(a.key.equals(b.key)).toBe(false);
    });

    it('produces different keys for different passphrases with same salt', () => {
      const salt = generateMachineSalt();
      const a = deriveFromSecrets('phrase-a', salt);
      const b = deriveFromSecrets('phrase-b', salt);
      expect(a.key.equals(b.key)).toBe(false);
    });

    it('reports source as pbkdf2-machine-bound', () => {
      const salt = generateMachineSalt();
      const km = deriveFromSecrets('test', salt);
      expect(km.source).toBe('pbkdf2-machine-bound');
    });

    it('produces different output than deriveFromPassphrase for the same input', () => {
      const salt = Buffer.alloc(32, 0);
      const pbkdf2 = deriveFromSecrets('same', salt);
      const sha256 = deriveFromPassphrase('same');
      expect(pbkdf2.key.equals(sha256.key)).toBe(false);
    });
  });

  describe('getMachineFingerprint', () => {
    it('returns a 32-byte buffer', () => {
      const fp = getMachineFingerprint('/tmp/app');
      expect(fp).toHaveLength(32);
    });

    it('is deterministic for the same path', () => {
      const a = getMachineFingerprint('/tmp/app');
      const b = getMachineFingerprint('/tmp/app');
      expect(a.equals(b)).toBe(true);
    });

    it('produces different fingerprints for different paths', () => {
      const a = getMachineFingerprint('/tmp/app-a');
      const b = getMachineFingerprint('/tmp/app-b');
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('generateMachineSalt', () => {
    it('returns a 32-byte buffer', () => {
      const salt = generateMachineSalt();
      expect(salt).toHaveLength(32);
    });

    it('produces different salts on each call', () => {
      const a = generateMachineSalt();
      const b = generateMachineSalt();
      expect(a.equals(b)).toBe(false);
    });
  });

  describe('zeroBuffer', () => {
    it('fills the buffer with zeros', () => {
      const buf = Buffer.from('sensitive-data-here-xxxxxxxx');
      zeroBuffer(buf);
      expect(buf.every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('keyToHex', () => {
    it('converts a 32-byte key to a 64-character hex string', () => {
      const key = Buffer.alloc(32, 0xab);
      const hex = keyToHex(key);
      expect(hex).toHaveLength(64);
      expect(hex).toBe('ab'.repeat(32));
    });

    it('throws for keys that are not 32 bytes', () => {
      expect(() => keyToHex(Buffer.alloc(16))).toThrow('32 bytes');
      expect(() => keyToHex(Buffer.alloc(64))).toThrow('32 bytes');
    });
  });
});
