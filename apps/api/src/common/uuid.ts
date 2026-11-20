import { BadRequestException } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Rejects a path parameter that is not a UUID.
 *
 * A malformed id is a 400 rather than a 500 from PostgreSQL refusing the
 * `::uuid` cast. It is deliberately NOT a 404: the id is unusable, which is a
 * different fact from "there is no such row", and conflating them would hide
 * a client bug behind a plausible-looking answer.
 *
 * The parameter is named, because the caller supplied it themselves - naming
 * it reveals nothing they do not already know, unlike the field-level errors
 * login deliberately withholds.
 */
export function assertUuid(value: string, parameter: string): void {
  if (!UUID.test(value)) {
    throw new BadRequestException({
      error: 'invalid_request',
      message: `${parameter} must be a UUID.`,
    });
  }
}
