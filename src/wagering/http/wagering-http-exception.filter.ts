import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import { InvalidMoneyError } from "../../shared/domain/money";
import { InfrastructureUnavailableError } from "../../shared/application/infrastructure-unavailable-error";
import {
  InvalidReadRequestError,
  ReadResourceNotFoundError,
} from "../../shared/application/read-errors";
import {
  IdempotencyConflictError,
  InvalidWagerProcessingRequestError,
  ProviderTransactionConflictError,
  UnsupportedWagerTransactionKindError,
  WagerCurrencyMismatchError,
  WagerPlayerMismatchError,
  WagerWalletNotFoundError,
} from "../application/process-wager-transaction";

type ErrorResponse = { statusCode: number; message: string; error: string };
interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: ErrorResponse): void;
}

@Catch()
export class WageringHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    const mapping = this.mapException(exception);
    response.status(mapping.status).json(mapping.body);
  }

  private mapException(exception: unknown): {
    status: number;
    body: ErrorResponse;
  } {
    if (exception instanceof InvalidReadRequestError) {
      return this.error(
        HttpStatus.BAD_REQUEST,
        "Bad Request",
        exception.message,
      );
    }
    if (exception instanceof ReadResourceNotFoundError) {
      return this.error(HttpStatus.NOT_FOUND, "Not Found", exception.message);
    }
    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof ProviderTransactionConflictError
    ) {
      return this.error(HttpStatus.CONFLICT, "Conflict", exception.message);
    }
    if (exception instanceof WagerWalletNotFoundError) {
      return this.error(HttpStatus.NOT_FOUND, "Not Found", exception.message);
    }
    if (
      exception instanceof WagerPlayerMismatchError ||
      exception instanceof WagerCurrencyMismatchError
    ) {
      return this.error(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "Unprocessable Entity",
        exception.message,
      );
    }
    if (
      exception instanceof InvalidWagerProcessingRequestError ||
      exception instanceof UnsupportedWagerTransactionKindError ||
      exception instanceof InvalidMoneyError
    ) {
      return this.error(
        HttpStatus.BAD_REQUEST,
        "Bad Request",
        exception.message,
      );
    }
    if (exception instanceof InfrastructureUnavailableError) {
      return this.error(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Service Unavailable",
        exception.message,
      );
    }
    return this.error(
      HttpStatus.INTERNAL_SERVER_ERROR,
      "Internal Server Error",
      "Wager transaction processing failed",
    );
  }

  private error(
    status: number,
    error: string,
    message: string,
  ): { status: number; body: ErrorResponse } {
    return { status, body: { statusCode: status, error, message } };
  }
}
