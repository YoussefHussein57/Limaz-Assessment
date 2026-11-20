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
}

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
        redactText(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception)),
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

        return {
          statusCode,
          error: typeof record.error === 'string' ? record.error : defaultErrorCode(statusCode),
          message: redactText(messageOf(record.message) ?? exception.message),
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
