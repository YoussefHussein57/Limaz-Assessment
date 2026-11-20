import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'limaz:isPublic';

/**
 * Marks a route as reachable without any credential.
 *
 * Everything is protected by default: the authentication guard is registered
 * globally, so a new controller is guarded the moment it exists. Opening a
 * route therefore has to be written down, in the one place anyone reviewing
 * that route will read.
 *
 * The opposite arrangement - a middleware matched to `/v1/*` - fails silently
 * the first time someone adds a route outside the pattern.
 */
export const Public = () => SetMetadata(IS_PUBLIC, true);
