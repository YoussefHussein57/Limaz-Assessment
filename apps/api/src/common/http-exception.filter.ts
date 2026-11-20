import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { redactText } from './redact';

interface ErrorBody {
  readonly statusCode: number;
  readonly error: string;
  readonly message: string;
  /**
   * Optional, explicitly sanitised context for errors where the caller needs
   * more than a sentence to act - today only the 409 from ADR-001, which has
   * to name the conflicting field and the decision already issued.
   *
   * Opt-in, never automatic. An exception that does not set `details` has no
   * `details` key at all, so every existing error body is byte-for-byte what
   * it was before (regression tests F02-T03b, F02-T08, F03-T30).
   */
  readonly details?: Record<string, unknown>;
}

/**
 * What may appear inside `details`.
 *
 * Primitives only, one level deep plus one nested object, with every string
 * passed through the redactor. The restriction is the safeguard: a thrower
 * cannot accidentally attach a Prisma error, a request object or an entity
 * carrying a `payloadHash` or a `keyHash`, because anything that is not a
 * primitive or a shallow object of primitives is dropped rather than
 * serialised.
 */
const MAX_DETAIL_DEPTH = 2;

/**
 * One response shape for every error, and nothing in it that the caller did
 * not already know.
 *
 * Nest's default filter echoes a good deal of context, and an unhandled error
 * becomes a stack trace. Both are how internal detail - table names, driver
 * messages, and in Prisma's case the database password inside a connection
 * string - reaches an unauthenticated caller.
 *
 * So: known HttpExceptions keep their status and a cleaned message; everything
 * else becomes a flat 500 with a fixed string, logged in full on the server.
 * Request headers are never echoed, because that is where the credentials are.
 */
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpException');

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }

    const response = host.switchToHttp().getResponse<ServerResponse>();
    const body = this.toBody(exception);

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        redactText(
          exception instanceof Error ? (exception.stack ?? exception.message) : String(exception),
        ),
      );
    }

    response.statusCode = body.statusCode;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(body));
  }

  private toBody(exception: unknown): ErrorBody {
    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const payload = exception.getResponse();

      if (typeof payload === 'object' && payload !== null) {
        const record = payload as Record<string, unknown>;

        // Never on a 5xx. A server error means something went wrong that the
        // caller did not cause and cannot act on, and the existing rule for
        // those is a fixed string with the real cause in the server log. A
        // `details` object on a 500 would be a new way for internal shape to
        // reach an unauthenticated caller - exactly what this filter exists to
        // prevent. Nothing in the service attaches one, so this costs nothing
        // and closes the path before anybody tries.
        const details =
          statusCode >= HttpStatus.INTERNAL_SERVER_ERROR
            ? undefined
            : sanitiseDetails(record.details, MAX_DETAIL_DEPTH);

        return {
          statusCode,
          error: typeof record.error === 'string' ? record.error : defaultErrorCode(statusCode),
          message: redactText(messageOf(record.message) ?? exception.message),
          // Spread, so the key is ABSENT rather than `undefined` when there is
          // nothing to add. `JSON.stringify` drops an undefined value anyway,
          // but an absent key keeps the object identical in a deep comparison.
          ...(details ? { details } : {}),
        };
      }

      return {
        statusCode,
        error: defaultErrorCode(statusCode),
        message: redactText(String(payload)),
      };
    }

    // Anything unrecognised. The caller gets a fixed string; the real error is
    // in the server log and nowhere else.
    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: 'internal_error',
      message: 'An unexpected error occurred.',
    };
  }
}

/**
 * Copies only what is safe to publish, and drops everything else.
 *
 * An allow-list by TYPE rather than by field name: the thrower decides what to
 * include, but cannot include a shape that might carry a secret. A string is
 * redacted, a number or boolean is copied, a plain object is recursed into
 * once, and anything else - an Error, a Prisma payload, a Date, a function, an
 * array of objects, a class instance - is omitted entirely.
 *
 * Returns `undefined` when there is nothing left, so the key never appears.
 */
function sanitiseDetails(value: unknown, depth: number): Record<string, unknown> | undefined {
  if (depth <= 0 || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  // Only a plain object. A class instance could have getters with side effects
  // or a toJSON that reaches further than this function can see.
  const prototype = Object.getPrototypeOf(value) as object | null;

  if (prototype !== Object.prototype && prototype !== null) {
    return undefined;
  }

  const output: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') {
      output[key] = redactText(item);
    } else if (typeof item === 'number' || typeof item === 'boolean') {
      output[key] = item;
    } else if (typeof item === 'object' && item !== null) {
      const nested = sanitiseDetails(item, depth - 1);

      if (nested) {
        output[key] = nested;
      }
    }
    // Everything else is dropped without comment. Silence is correct here:
    // naming what was removed would itself describe the internal shape.
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

/** Validation errors arrive as an array of strings; join them readably. */
function messageOf(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string').join('; ');
  }

  return null;
}

function defaultErrorCode(statusCode: number): string {
  switch (statusCode) {
    case HttpStatus.BAD_REQUEST:
      return 'bad_request';
    case HttpStatus.UNAUTHORIZED:
      return 'unauthenticated';
    case HttpStatus.FORBIDDEN:
      return 'forbidden';
    case HttpStatus.NOT_FOUND:
      return 'not_found';
    case HttpStatus.CONFLICT:
      return 'conflict';
    case HttpStatus.UNPROCESSABLE_ENTITY:
      return 'unprocessable_entity';
    default:
      return 'error';
  }
}
