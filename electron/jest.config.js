/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleNameMapper: {
    '^electron$': '<rootDir>/__mocks__/electron.ts',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        target: 'ES2022',
        module: 'commonjs',
        lib: ['ES2022'],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        moduleResolution: 'node',
        types: ['node', 'jest'],
      },
    }],
  },
  collectCoverageFrom: [
    'domain/**/*.ts',
    'security/**/*.ts',
    'sync/**/*.ts',
    'ipc/handlers/**/*.ts',
    'ipc/gateway.ts',
    'database/**/*.ts',
    'shared/**/*.ts',
    '!**/__tests__/**',
    '!**/__mocks__/**',
  ],
};
