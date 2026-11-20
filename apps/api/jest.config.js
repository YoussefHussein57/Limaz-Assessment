/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',
  // Globs rather than a regex: unit specs live beside the code, integration
  // and e2e specs live under test/.
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/test/**/*.spec.ts',
    '<rootDir>/test/**/*.e2e-spec.ts',
  ],
  moduleFileExtensions: ['js', 'json', 'ts'],
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // Creates and migrates the throwaway limaz_test database before any suite,
  // behind an advisory lock so two runs cannot drop it out from under each
  // other (test/suite-lock.ts).
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  testTimeout: 30000,

  // Integration suites share one PostgreSQL database, and several of them
  // assert on exact row counts. Run in parallel they see each other's rows:
  // the seed suite counted 4 companies because the constraints suite had
  // created two of its own at the same moment.
  //
  // One worker makes each suite's reset-then-populate actually mean something.
  // It does NOT limit concurrency *inside* a test - the Promise.all races in
  // F03 and F04 are bounded by the connection pool, not by worker count.
  maxWorkers: 1,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  collectCoverageFrom: ['src/**/*.ts'],
  coverageDirectory: 'coverage',
};
