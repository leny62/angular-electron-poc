/**
 * Jest config for the packages workspace.
 *
 * Separate from `electron/jest.config.js` because the packages are the future
 * of this codebase and the `electron/` tree is the harness. Both run in CI:
 *   npm run test:packages
 *   npm run test:electron
 */

/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/__tests__/**/*.test.ts'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  moduleNameMapper: {
    '^@bizuri/local-store$': '<rootDir>/local-store/src/index.ts',
    '^@bizuri/local-engine$': '<rootDir>/local-engine/src/index.ts',
    '^electron$': '<rootDir>/__mocks__/electron.ts',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2022',
          module: 'commonjs',
          lib: ['ES2022'],
          strict: true,
          noUncheckedIndexedAccess: true,
          esModuleInterop: true,
          skipLibCheck: true,
          resolveJsonModule: true,
          moduleResolution: 'node',
          types: ['node', 'jest'],
          // Mirrors tsconfig.base.json. moduleNameMapper handles runtime
          // resolution; these paths are what let ts-jest type-check the
          // cross-package imports.
          baseUrl: __dirname,
          paths: {
            '@bizuri/local-store': ['local-store/src/index.ts'],
            '@bizuri/local-engine': ['local-engine/src/index.ts'],
          },
        },
      },
    ],
  },
  collectCoverageFrom: [
    'local-store/src/**/*.ts',
    'local-engine/src/**/*.ts',
    'offline-http/src/**/*.ts',
    '!**/__tests__/**',
    '!**/__mocks__/**',
    '!**/index.ts',
  ],
};
