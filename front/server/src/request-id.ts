import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

declare module "express-serve-static-core" {
  interface Request {
    requestId: string;
  }
}

export function createRequestId(): string {
  return `req_${randomUUID()}`;
}

export function isSafeRequestId(value: string): boolean {
  return SAFE_REQUEST_ID_PATTERN.test(value);
}

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  const inboundRequestId = request.header(REQUEST_ID_HEADER);
  const requestId =
    inboundRequestId && isSafeRequestId(inboundRequestId)
      ? inboundRequestId
      : createRequestId();

  request.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  next();
}
