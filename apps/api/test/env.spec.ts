import { EnvValidationError, parseEnv } from '../src/config/env.schema';

/**
 * F00-T06 - invalid configuration must fail fast with a message that names the
 * offending variable, and must never echo the variable's value.
 */
describe('parseEnv', () => {
  const validEnv = {
    NODE_ENV: 'test',
    API_PORT: '3001',
    DATABASE_URL: 'postgresql://user:pw@localhost:5432/db?schema=public',
  } satisfies NodeJS.ProcessEnv;

  it('accepts a valid environment and returns typed values', () => {
    const env = parseEnv(validEnv);

    expect(env.NODE_ENV).toBe('test');
    expect(env.API_PORT).toBe(3001);
    expect(typeof env.API_PORT).toBe('number');
    expect(env.DATABASE_URL).toBe(validEnv.DATABASE_URL);
  });

  it('applies defaults for optional variables', () => {
    const env = parseEnv({ DATABASE_URL: validEnv.DATABASE_URL });

    expect(env.NODE_ENV).toBe('development');
    expect(env.API_PORT).toBe(3001);
  });

  it('rejects a missing DATABASE_URL and names it', () => {
    expect(() => parseEnv({ NODE_ENV: 'test' })).toThrow(EnvValidationError);

    try {
      parseEnv({ NODE_ENV: 'test' });
      fail('expected parseEnv to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      expect((error as EnvValidationError).problems.join('\n')).toContain('DATABASE_URL');
    }
  });

  it('rejects a DATABASE_URL that is not a PostgreSQL connection string', () => {
    expect(() => parseEnv({ ...validEnv, DATABASE_URL: 'mysql://user:pw@host/db' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a non-numeric API_PORT', () => {
    expect(() => parseEnv({ ...validEnv, API_PORT: 'not-a-port' })).toThrow(EnvValidationError);
  });

  it('rejects an out-of-range API_PORT', () => {
    expect(() => parseEnv({ ...validEnv, API_PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ ...validEnv, NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('never includes the offending value in the error message', () => {
    const secret = 'postgresql://admin:SUPER_SECRET_PASSWORD@host/db';

    try {
      // Invalid because NODE_ENV is wrong; DATABASE_URL is valid but sensitive.
      parseEnv({ NODE_ENV: 'nope', DATABASE_URL: secret });
      fail('expected parseEnv to throw');
    } catch (error) {
      expect((error as EnvValidationError).message).not.toContain('SUPER_SECRET_PASSWORD');
    }
  });

  it('reports every problem at once rather than only the first', () => {
    try {
      parseEnv({ NODE_ENV: 'nope', API_PORT: 'abc' });
      fail('expected parseEnv to throw');
    } catch (error) {
      const problems = (error as EnvValidationError).problems;
      expect(problems.length).toBeGreaterThanOrEqual(3);
    }
  });
});
