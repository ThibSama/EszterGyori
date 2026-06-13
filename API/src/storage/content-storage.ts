import { constants } from "node:fs";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ZodError, type ZodType } from "zod";
import {
  CONTENT_ENVELOPE_SCHEMA_VERSION,
  type PublishedContentEnvelopeV1,
  type ServerDraftEnvelopeV1,
  publishedContentEnvelopeV1Schema,
  serverDraftEnvelopeV1Schema,
} from "@eszter/contracts";
import type { SiteContent } from "@eszter/contracts";
import { writeJsonFileAtomically } from "./atomic-json-file";
import { StorageError } from "./storage-errors";

const MAX_CONTENT_FILE_BYTES = 1024 * 1024;

export type StorageFileStatus = "created" | "validated";

export interface StorageInitializationResult {
  draft: StorageFileStatus;
  published: StorageFileStatus;
}

export interface ContentStorage {
  initialize(seedContent: SiteContent): Promise<StorageInitializationResult>;
  readDraft(): Promise<ServerDraftEnvelopeV1>;
  readPublished(): Promise<PublishedContentEnvelopeV1>;
  writeDraft(envelope: unknown): Promise<void>;
  writePublished(envelope: unknown): Promise<void>;
}

interface FileDescriptor<TEnvelope> {
  role: "draft" | "published";
  path: string;
  schema: ZodType<TEnvelope>;
  createSeed(seedContent: SiteContent, timestamp: string): TEnvelope;
}

export class JsonContentStorage implements ContentStorage {
  readonly draftPath: string;
  readonly publishedPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private readonly now: () => Date;

  constructor(
    private readonly dataDirectory: string,
    options: { now?: () => Date } = {},
  ) {
    this.draftPath = join(dataDirectory, "draft.json");
    this.publishedPath = join(dataDirectory, "published.json");
    this.now = options.now ?? (() => new Date());
  }

  async initialize(seedContent: SiteContent): Promise<StorageInitializationResult> {
    try {
      await mkdir(this.dataDirectory, { recursive: true });
    } catch (error) {
      throw new StorageError(
        "STORAGE_DIRECTORY_FAILED",
        "Failed to create content storage directory.",
        { cause: error },
      );
    }

    const timestamp = this.now().toISOString();
    const draft = await this.ensureFile(this.draftDescriptor(), seedContent, timestamp);
    const published = await this.ensureFile(
      this.publishedDescriptor(),
      seedContent,
      timestamp,
    );

    return { draft, published };
  }

  async readDraft(): Promise<ServerDraftEnvelopeV1> {
    return this.readEnvelope(this.draftDescriptor());
  }

  async readPublished(): Promise<PublishedContentEnvelopeV1> {
    return this.readEnvelope(this.publishedDescriptor());
  }

  async writeDraft(envelope: unknown): Promise<void> {
    const parsed = parseEnvelope(
      this.draftDescriptor().schema,
      envelope,
      this.draftDescriptor().role,
    );
    await this.enqueueWrite(() => writeJsonFileAtomically(this.draftPath, parsed));
  }

  async writePublished(envelope: unknown): Promise<void> {
    const parsed = parseEnvelope(
      this.publishedDescriptor().schema,
      envelope,
      this.publishedDescriptor().role,
    );
    await this.enqueueWrite(() => writeJsonFileAtomically(this.publishedPath, parsed));
  }

  private draftDescriptor(): FileDescriptor<ServerDraftEnvelopeV1> {
    return {
      role: "draft",
      path: this.draftPath,
      schema: serverDraftEnvelopeV1Schema,
      createSeed: (content, timestamp) =>
        serverDraftEnvelopeV1Schema.parse({
          schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
          revision: 0,
          updatedAt: timestamp,
          content,
        }),
    };
  }

  private publishedDescriptor(): FileDescriptor<PublishedContentEnvelopeV1> {
    return {
      role: "published",
      path: this.publishedPath,
      schema: publishedContentEnvelopeV1Schema,
      createSeed: (content, timestamp) =>
        publishedContentEnvelopeV1Schema.parse({
          schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
          revision: 0,
          publishedAt: timestamp,
          content,
        }),
    };
  }

  private async ensureFile<TEnvelope>(
    descriptor: FileDescriptor<TEnvelope>,
    seedContent: SiteContent,
    timestamp: string,
  ): Promise<StorageFileStatus> {
    const exists = await fileExists(descriptor.path);
    if (exists) {
      await this.readEnvelope(descriptor);
      return "validated";
    }

    const seed = descriptor.createSeed(seedContent, timestamp);
    await writeJsonFileAtomically(descriptor.path, seed);
    return "created";
  }

  private async readEnvelope<TEnvelope>(
    descriptor: FileDescriptor<TEnvelope>,
  ): Promise<TEnvelope> {
    let fileStat: Awaited<ReturnType<typeof stat>>;
    try {
      fileStat = await stat(descriptor.path);
    } catch (error) {
      throw new StorageError(
        "STORAGE_FILE_NOT_FOUND",
        `Missing ${descriptor.role} content file.`,
        { cause: error, fileRole: descriptor.role },
      );
    }

    if (fileStat.size > MAX_CONTENT_FILE_BYTES) {
      throw new StorageError(
        "STORAGE_FILE_TOO_LARGE",
        `${descriptor.role} content file is too large.`,
        { fileRole: descriptor.role },
      );
    }

    let raw: string;
    try {
      raw = await readFile(descriptor.path, "utf8");
    } catch (error) {
      throw new StorageError(
        "STORAGE_READ_FAILED",
        `Failed to read ${descriptor.role} content file.`,
        { cause: error, fileRole: descriptor.role },
      );
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch (error) {
      throw new StorageError(
        "STORAGE_INVALID_JSON",
        `${descriptor.role} content file contains invalid JSON.`,
        { cause: error, fileRole: descriptor.role },
      );
    }

    return parseEnvelope(descriptor.schema, parsedJson, descriptor.role);
  }

  private async enqueueWrite(writeOperation: () => Promise<void>): Promise<void> {
    const nextWrite = this.writeQueue.then(writeOperation, writeOperation);
    this.writeQueue = nextWrite.catch(() => undefined);
    await nextWrite;
  }
}

export function createContentStorage(
  dataDirectory: string,
  options?: { now?: () => Date },
): JsonContentStorage {
  return new JsonContentStorage(dataDirectory, options);
}

function parseEnvelope<TEnvelope>(
  schema: ZodType<TEnvelope>,
  candidate: unknown,
  fileRole: string,
): TEnvelope {
  try {
    return schema.parse(candidate);
  } catch (error) {
    throw new StorageError(
      "STORAGE_VALIDATION_FAILED",
      `${fileRole} content file failed schema validation.`,
      { cause: error instanceof ZodError ? error : error, fileRole },
    );
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
