/** @type {import('jest').Config} */
module.exports = {
  rootDir: '.',
  testEnvironment: 'node',

  /*
   * ONLY pure modules are tested here.
   *
   * `lib/format.ts` and `lib/expense-reasons.ts` import nothing from React,
   * Next or the DOM - they are functions over data, and they carry the two
   * pieces of logic in this feature that are genuinely easy to get silently
   * wrong: minor-unit conversion and reading a `Json` column defensively.
   *
   * Component behaviour is NOT tested here. That would need a DOM environment
   * and a React testing library, which is the heavyweight frontend runner this
   * feature deliberately did not add. Those scenarios (F06-T22 to T38) are
   * verified in a real browser against the Docker stack and recorded as such
   * in docs/testing/F06-test-matrix.md - never marked PASS without being run.
   *
   * No globalSetup: unlike the API suite there is no database to create.
   */
  testMatch: ['<rootDir>/lib/**/*.spec.ts'],
  moduleFileExtensions: ['js', 'json', 'ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
