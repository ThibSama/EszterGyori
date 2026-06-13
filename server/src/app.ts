import express from "express";
import type { ErrorRequestHandler, Request, Response } from "express";
import { ZodError } from "zod";
import { SITE_CONTENT_SCHEMA_VERSION } from "../../contracts/site-content";
import { HttpError, createErrorBody } from "./http-error";
import { requestIdMiddleware } from "./request-id";

export const SERVICE_NAME = "eszter-api";
const JSON_LIMIT = "64kb";

function sendMethodNotAllowed(request: Request, response: Response) {
  response.setHeader("Allow", "GET");
  response
    .status(405)
    .json(
      createErrorBody(
        "METHOD_NOT_ALLOWED",
        "Méthode non autorisée pour cette ressource.",
        request.requestId,
      ),
    );
}

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(requestIdMiddleware);
  app.use(express.json({ limit: JSON_LIMIT }));

  app.get("/api/health", (_request, response) => {
    response.status(200).json({
      status: "ok",
      service: SERVICE_NAME,
      contentSchemaVersion: SITE_CONTENT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
    });
  });

  app.all("/api/health", sendMethodNotAllowed);

  app.use((request, response) => {
    response
      .status(404)
      .json(
        createErrorBody(
          "NOT_FOUND",
          "La ressource demandée est introuvable.",
          request.requestId,
        ),
      );
  });

  const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    if (response.headersSent) {
      return;
    }

    if (error instanceof SyntaxError && "body" in error) {
      response
        .status(400)
        .json(
          createErrorBody(
            "INVALID_JSON",
            "Le corps JSON est invalide.",
            request.requestId,
          ),
        );
      return;
    }

    if (error instanceof HttpError) {
      response
        .status(error.statusCode)
        .json(createErrorBody(error.code, error.message, request.requestId));
      return;
    }

    if (error instanceof ZodError) {
      response
        .status(400)
        .json(
          createErrorBody(
            "INVALID_CONFIGURATION",
            "La configuration du serveur est invalide.",
            request.requestId,
          ),
        );
      return;
    }

    console.error("Unexpected request error", {
      requestId: request.requestId,
      error,
    });

    response
      .status(500)
      .json(
        createErrorBody(
          "INTERNAL_ERROR",
          "Une erreur interne est survenue.",
          request.requestId,
        ),
      );
  };

  app.use(errorHandler);

  return app;
}
