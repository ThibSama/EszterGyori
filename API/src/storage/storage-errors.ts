export type StorageErrorCode =
  | "STORAGE_DIRECTORY_FAILED"
  | "STORAGE_FILE_NOT_FOUND"
  | "STORAGE_FILE_TOO_LARGE"
  | "STORAGE_READ_FAILED"
  | "STORAGE_INVALID_JSON"
  | "STORAGE_VALIDATION_FAILED"
  | "STORAGE_WRITE_FAILED"
  | "STORAGE_RENAME_FAILED";

export class StorageError extends Error {
  readonly code: StorageErrorCode;
  readonly fileRole?: string;

  constructor(
    code: StorageErrorCode,
    message: string,
    options?: { cause?: unknown; fileRole?: string },
  ) {
    super(message, { cause: options?.cause });
    this.name = "StorageError";
    this.code = code;
    this.fileRole = options?.fileRole;
  }
}

export function isStorageError(error: unknown): error is StorageError {
  return error instanceof StorageError;
}
