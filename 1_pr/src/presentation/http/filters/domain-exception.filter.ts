import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  CustomerNotFoundError,
  DomainError,
  EmailConflictError,
  OrderValidationError,
  ProductNotFoundError,
} from '../../../domain/errors';

@Catch(DomainError)
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: DomainError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = resolveStatus(exception);
    res.status(status).json({
      statusCode: status,
      message: exception.message,
      error: HttpStatus[status] ?? 'Error',
    });
  }
}

function resolveStatus(exception: DomainError): number {
  if (
    exception instanceof CustomerNotFoundError ||
    exception instanceof ProductNotFoundError
  ) {
    return HttpStatus.NOT_FOUND;
  }
  if (exception instanceof EmailConflictError) {
    return HttpStatus.CONFLICT;
  }
  if (exception instanceof OrderValidationError) {
    return HttpStatus.BAD_REQUEST;
  }
  return HttpStatus.BAD_REQUEST;
}
