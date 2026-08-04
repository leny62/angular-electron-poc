import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as os from 'os';

const SERVICE_NAME = 'com.bizuri.electron-poc';
const ACCOUNT_NAME = 'machine-salt';

export interface CredentialStore {
  readonly storeSalt: (salt: Buffer) => void;
  readonly retrieveSalt: () => Buffer | null;
  readonly deleteSalt: () => void;
}

function macOsStore(): CredentialStore {
  return {
    storeSalt(salt: Buffer): void {
      const hex = salt.toString('hex');
      execSync(
        `security add-generic-password -a "${ACCOUNT_NAME}" -s "${SERVICE_NAME}" -w "${hex}" -U`,
        { stdio: 'ignore' },
      );
    },
    retrieveSalt(): Buffer | null {
      try {
        const hex = execSync(
          `security find-generic-password -a "${ACCOUNT_NAME}" -s "${SERVICE_NAME}" -w`,
          { stdio: ['ignore', 'pipe', 'ignore'] },
        )
          .toString()
          .trim();
        if (hex.length === 64) {
          return Buffer.from(hex, 'hex');
        }
        return null;
      } catch {
        return null;
      }
    },
    deleteSalt(): void {
      try {
        execSync(
          `security delete-generic-password -a "${ACCOUNT_NAME}" -s "${SERVICE_NAME}"`,
          { stdio: 'ignore' },
        );
      } catch {
        // Already deleted or never stored.
      }
    },
  };
}

function linuxStore(): CredentialStore {
  return {
    storeSalt(salt: Buffer): void {
      const hex = salt.toString('hex');
      try {
        execSync(
          `echo "${hex}" | secret-tool store --label="Bizuri PoC Machine Salt" service "${SERVICE_NAME}" account "${ACCOUNT_NAME}"`,
          { stdio: 'ignore' },
        );
      } catch {
        throw new Error(
          'secret-tool not available. Install libsecret-tools for credential storage.',
        );
      }
    },
    retrieveSalt(): Buffer | null {
      try {
        const hex = execSync(
          `secret-tool lookup service "${SERVICE_NAME}" account "${ACCOUNT_NAME}"`,
          { stdio: ['ignore', 'pipe', 'ignore'] },
        )
          .toString()
          .trim();
        if (hex.length === 64) {
          return Buffer.from(hex, 'hex');
        }
        return null;
      } catch {
        return null;
      }
    },
    deleteSalt(): void {
      try {
        execSync(
          `secret-tool clear service "${SERVICE_NAME}" account "${ACCOUNT_NAME}"`,
          { stdio: 'ignore' },
        );
      } catch {
        // Already deleted.
      }
    },
  };
}

function windowsStore(): CredentialStore {
  return {
    storeSalt(salt: Buffer): void {
      const hex = salt.toString('hex');
      execSync(
        `cmdkey /generic:${SERVICE_NAME}/${ACCOUNT_NAME} /user:${ACCOUNT_NAME} /pass:${hex}`,
        { stdio: 'ignore' },
      );
    },
    retrieveSalt(): Buffer | null {
      try {
        const output = execSync(
          `cmdkey /generic:${SERVICE_NAME}/${ACCOUNT_NAME}`,
          { stdio: ['ignore', 'pipe', 'ignore'] },
        ).toString();

        const match = output.match(/Password: (.+)/);
        if (match?.[1] && match[1].length === 64) {
          return Buffer.from(match[1], 'hex');
        }
        return null;
      } catch {
        return null;
      }
    },
    deleteSalt(): void {
      try {
        execSync(
          `cmdkey /delete:${SERVICE_NAME}/${ACCOUNT_NAME}`,
          { stdio: 'ignore' },
        );
      } catch {
        // Already deleted.
      }
    },
  };
}

export function createCredentialStore(): CredentialStore {
  switch (os.platform()) {
    case 'darwin':
      return macOsStore();
    case 'linux':
      return linuxStore();
    case 'win32':
      return windowsStore();
    default:
      throw new Error(`Unsupported platform: ${os.platform()}`);
  }
}

export function generateAndStoreSalt(store: CredentialStore): Buffer {
  const salt = randomBytes(32);
  store.storeSalt(salt);
  return salt;
}

export function getOrCreateSalt(store: CredentialStore): Buffer {
  const existing = store.retrieveSalt();
  if (existing) {
    return existing;
  }
  return generateAndStoreSalt(store);
}
