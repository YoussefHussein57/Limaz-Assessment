import { SetMetadata } from '@nestjs/common';
import type { CallerType } from '../principal.types';

export const ALLOWED_CALLER_TYPES = 'limaz:callerTypes';

/**
 * Restricts a route to a kind of caller.
 *
 * An API key authenticates a COMPANY; a session authenticates a PERSON. A
 * valid credential of the wrong kind is still the wrong kind: a company
 * backend must never be able to act as a manager just because its key is
 * genuine.
 *
 * With no decorator a route accepts both - which is right for
 * `GET /v1/auth/me`, and wrong for anything a person is accountable for.
 */
export const AllowCallerTypes = (...types: CallerType[]) =>
  SetMetadata(ALLOWED_CALLER_TYPES, types);
