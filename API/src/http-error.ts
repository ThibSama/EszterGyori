export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createErrorBody(
  code: string,
  message: string,
  requestId: string,
): ApiErrorBody {
  return {
    error: {
      code,
      message,
      requestId,
    },
  };
}
