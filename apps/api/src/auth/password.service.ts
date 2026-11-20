import { Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env.schema';

/**
 * Password hashing and verification.
 *
 * bcrypt here, SHA-256 for session tokens and API keys. That is not an
 * inconsistency - it follows from entropy:
 *
 *   Passwords are chosen by people, so they have little entropy and must be
 *   expensive to guess. bcrypt is deliberately slow and salts per row.
 *
 *   Session tokens and API keys are 256 bits from a CSPRNG. Guessing one is
 *   infeasible regardless of hash speed, so slowness buys nothing - and
 *   bcrypt's per-row salt would make `WHERE hash = $1` impossible, turning
 *   every authenticated request into a full table scan.
 */
@Injectable()
export class PasswordService {
  private readonly cost: number;

  /**
   * A valid bcrypt hash of a value nobody knows, generated once at startup.
   *
   * It exists so that `verifyWithTimingFloor` can do real bcrypt work when
   * there is no user to check against. Without it, an unknown email would
   * return in microseconds while a known email with the wrong password would
   * take ~100ms - and that difference alone tells an attacker which addresses
   * are registered.
   */
  private readonly dummyHash: string;

  constructor(@Inject(ENV) env: Env) {
    this.cost = env.BCRYPT_COST;
    this.dummyHash = bcrypt.hashSync('not-a-real-password', this.cost);
  }

  async hash(plaintext: string): Promise<string> {
    return bcrypt.hash(plaintext, this.cost);
  }

  /**
   * Verifies a password, taking the same amount of work whether or not a user
   * was found.
   *
   * Pass `null` when the email matched nothing: bcrypt still runs, against the
   * dummy hash, and the answer is still `false`.
   */
  async verifyWithTimingFloor(plaintext: string, storedHash: string | null): Promise<boolean> {
    const matched = await bcrypt.compare(plaintext, storedHash ?? this.dummyHash);

    // Belt and braces: if storedHash was null we did the work but the answer
    // must be false regardless of what bcrypt returned for the dummy.
    return storedHash !== null && matched;
  }
}
