import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import { InfrastructureUnavailableError } from "../application/infrastructure-unavailable-error";
import {
  InvalidReadRequestError,
  ReadResourceNotFoundError,
} from "../application/read-errors";

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: { statusCode: number; error: string; message: string }): void;
}

@Catch()
export class ReadHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<HttpResponse>();
    if (exception instanceof InvalidReadRequestError) {
      response.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        error: "Bad Request",
        message: exception.message,
      });
      return;
    }
    if (exception instanceof ReadResourceNotFoundError) {
      response.status(HttpStatus.NOT_FOUND).json({
        statusCode: HttpStatus.NOT_FOUND,
        error: "Not Found",
        message: exception.message,
      });
      return;
    }
    if (exception instanceof InfrastructureUnavailableError) {
      response.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        statusCode: HttpStatus.SERVICE_UNAVAILABLE,
        error: "Service Unavailable",
        message: exception.message,
      });
      return;
    }
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: "Internal Server Error",
      message: "Read request failed",
    });
  }
}
