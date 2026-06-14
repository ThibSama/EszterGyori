import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_ENVELOPE_SCHEMA_VERSION,
  defaultSiteAppearance,
  type PublishedContentEnvelopeV1,
  type ServerDraftEnvelopeV1,
  publishedContentEnvelopeV1Schema,
  serverDraftEnvelopeV1Schema,
} from "@eszter/contracts";
import { defaultSiteContent } from "@eszter/contracts";
import { createContentStorage } from "../src/storage/content-storage";
import { StorageError } from "../src/storage/storage-errors";

const FIXED_DATE = new Date("2026-06-13T10:00:00.000Z");

async function withTemporaryDirectory<T>(
  run: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "eszter-content-storage-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createDraft(
  overrides: Partial<ServerDraftEnvelopeV1> = {},
): ServerDraftEnvelopeV1 {
  return serverDraftEnvelopeV1Schema.parse({
    schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
    revision: 1,
    updatedAt: "2026-06-13T11:00:00.000Z",
    content: defaultSiteContent,
    ...overrides,
  });
}

function createPublished(
  overrides: Partial<PublishedContentEnvelopeV1> = {},
): PublishedContentEnvelopeV1 {
  return publishedContentEnvelopeV1Schema.parse({
    schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
    revision: 1,
    publishedAt: "2026-06-13T11:00:00.000Z",
    content: defaultSiteContent,
    ...overrides,
  });
}

function createLegacyContentWithoutAppearance() {
  const { appearance: _appearance, ...legacyContent } = defaultSiteContent;
  return legacyContent;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

test("initialization creates missing directory and seeds both content files", async () => {
  await withTemporaryDirectory(async (root) => {
    const dataDirectory = join(root, "nested", "content");
    const storage = createContentStorage(dataDirectory, { now: () => FIXED_DATE });

    const result = await storage.initialize(defaultSiteContent);
    assert.deepEqual(result, { draft: "created", published: "created" });

    const draft = await storage.readDraft();
    const published = await storage.readPublished();

    assert.equal(draft.revision, 0);
    assert.equal(published.revision, 0);
    assert.equal(draft.updatedAt, FIXED_DATE.toISOString());
    assert.equal(published.publishedAt, FIXED_DATE.toISOString());
    assert.deepEqual(draft.content, defaultSiteContent);
    assert.deepEqual(published.content, defaultSiteContent);
    assert.equal(new Date(draft.updatedAt).toISOString(), draft.updatedAt);
    assert.equal(new Date(published.publishedAt).toISOString(), published.publishedAt);
  });
});

test("initialization is idempotent and preserves valid existing files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory, { now: () => FIXED_DATE });
    await storage.initialize(defaultSiteContent);

    const draft = createDraft({ revision: 7 });
    const published = createPublished({ revision: 9 });
    await storage.writeDraft(draft);
    await storage.writePublished(published);

    const secondStorage = createContentStorage(directory, {
      now: () => new Date("2026-06-14T10:00:00.000Z"),
    });
    const result = await secondStorage.initialize(defaultSiteContent);

    assert.deepEqual(result, { draft: "validated", published: "validated" });
    assert.deepEqual(await secondStorage.readDraft(), draft);
    assert.deepEqual(await secondStorage.readPublished(), published);
  });
});

test("draft and published content persist across storage instances", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);

    const draft = createDraft({ revision: 12 });
    const published = createPublished({ revision: 13 });
    await storage.writeDraft(draft);
    await storage.writePublished(published);

    const restartedStorage = createContentStorage(directory);
    assert.deepEqual(await restartedStorage.readDraft(), draft);
    assert.deepEqual(await restartedStorage.readPublished(), published);
  });
});

test("malformed JSON, invalid envelopes and unsupported versions fail initialization", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);

    await writeFile(join(directory, "draft.json"), "{invalid-json", "utf8");
    await assert.rejects(
      () => createContentStorage(directory).initialize(defaultSiteContent),
      (error: unknown) =>
        error instanceof StorageError && error.code === "STORAGE_INVALID_JSON",
    );

    await storage.writeDraft(createDraft());
    await writeFile(
      join(directory, "draft.json"),
      `${JSON.stringify({ schemaVersion: 1, revision: -1, updatedAt: FIXED_DATE.toISOString(), content: defaultSiteContent })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => createContentStorage(directory).initialize(defaultSiteContent),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "STORAGE_VALIDATION_FAILED",
    );

    await writeFile(
      join(directory, "draft.json"),
      `${JSON.stringify({ ...createDraft(), schemaVersion: 999 })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => createContentStorage(directory).initialize(defaultSiteContent),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "STORAGE_VALIDATION_FAILED",
    );
  });
});

test("invalid content IDs and oversized files are rejected", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);

    const invalidContent = structuredClone(defaultSiteContent);
    invalidContent.services.items[0].id = "eyeliner";
    await writeFile(
      join(directory, "draft.json"),
      `${JSON.stringify({ ...createDraft(), content: invalidContent })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => createContentStorage(directory).initialize(defaultSiteContent),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "STORAGE_VALIDATION_FAILED",
    );

    await writeFile(join(directory, "draft.json"), "x".repeat(1024 * 1024 + 1));
    await assert.rejects(
      () => createContentStorage(directory).initialize(defaultSiteContent),
      (error: unknown) =>
        error instanceof StorageError && error.code === "STORAGE_FILE_TOO_LARGE",
    );
  });
});

test("invalid write input does not modify an existing valid file", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);
    const validDraft = createDraft({ revision: 21 });
    await storage.writeDraft(validDraft);
    const before = await readFile(join(directory, "draft.json"), "utf8");

    await assert.rejects(
      () => storage.writeDraft({ ...validDraft, schemaVersion: 999 }),
      (error: unknown) =>
        error instanceof StorageError &&
        error.code === "STORAGE_VALIDATION_FAILED",
    );

    assert.equal(await readFile(join(directory, "draft.json"), "utf8"), before);
    assert.deepEqual(await storage.readDraft(), validDraft);
  });
});

test("atomic writes leave valid files, no temp files and serialize concurrent writes", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);

    await storage.writeDraft(createDraft({ revision: 30 }));
    let files = await readdir(directory);
    assert.deepEqual(
      files.filter((file) => file.endsWith(".tmp")),
      [],
    );
    serverDraftEnvelopeV1Schema.parse(await readJson(join(directory, "draft.json")));

    await Promise.all(
      Array.from({ length: 10 }, (_value, index) =>
        storage.writeDraft(createDraft({ revision: 40 + index })),
      ),
    );

    const finalDraft = await storage.readDraft();
    assert.equal(finalDraft.revision, 49);
    files = await readdir(directory);
    assert.deepEqual(
      files.filter((file) => file.endsWith(".tmp")),
      [],
    );
  });
});

test("partial initialization creates only missing counterpart files", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);
    const draft = createDraft({ revision: 51 });
    await storage.writeDraft(draft);
    await rm(join(directory, "published.json"));

    const result = await createContentStorage(directory, {
      now: () => FIXED_DATE,
    }).initialize(defaultSiteContent);

    assert.deepEqual(result, { draft: "validated", published: "created" });
    assert.deepEqual(await createContentStorage(directory).readDraft(), draft);
    assert.equal((await createContentStorage(directory).readPublished()).revision, 0);
  });

  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);
    const published = createPublished({ revision: 52 });
    await storage.writePublished(published);
    await rm(join(directory, "draft.json"));

    const result = await createContentStorage(directory, {
      now: () => FIXED_DATE,
    }).initialize(defaultSiteContent);

    assert.deepEqual(result, { draft: "created", published: "validated" });
    assert.deepEqual(await createContentStorage(directory).readPublished(), published);
    assert.equal((await createContentStorage(directory).readDraft()).revision, 0);
  });
});

test("legacy stored content without appearance is accepted and not rewritten", async () => {
  await withTemporaryDirectory(async (directory) => {
    const legacyDraft = {
      schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
      revision: 3,
      updatedAt: "2026-06-13T11:00:00.000Z",
      content: createLegacyContentWithoutAppearance(),
    };
    const legacyPublished = {
      schemaVersion: CONTENT_ENVELOPE_SCHEMA_VERSION,
      revision: 4,
      publishedAt: "2026-06-13T11:00:00.000Z",
      content: createLegacyContentWithoutAppearance(),
    };

    const draftPath = join(directory, "draft.json");
    const publishedPath = join(directory, "published.json");
    await writeFile(draftPath, `${JSON.stringify(legacyDraft, null, 2)}\n`, "utf8");
    await writeFile(
      publishedPath,
      `${JSON.stringify(legacyPublished, null, 2)}\n`,
      "utf8",
    );
    const beforeDraft = await readFile(draftPath, "utf8");
    const beforePublished = await readFile(publishedPath, "utf8");

    const storage = createContentStorage(directory);
    assert.deepEqual(await storage.initialize(defaultSiteContent), {
      draft: "validated",
      published: "validated",
    });

    assert.deepEqual((await storage.readDraft()).content.appearance, defaultSiteAppearance);
    assert.deepEqual(
      (await storage.readPublished()).content.appearance,
      defaultSiteAppearance,
    );
    assert.equal(await readFile(draftPath, "utf8"), beforeDraft);
    assert.equal(await readFile(publishedPath, "utf8"), beforePublished);
  });
});

test("custom appearance survives storage read", async () => {
  await withTemporaryDirectory(async (directory) => {
    const customContent = {
      ...defaultSiteContent,
      appearance: {
        palette: {
          ...defaultSiteAppearance.palette,
          background: "#F0F1F4" as const,
          primary: "#3D4845" as const,
        },
        sectionTints: {
          ...defaultSiteAppearance.sectionTints,
          contact: "#CDD1D8" as const,
        },
      },
    };
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);
    await storage.writePublished(createPublished({ content: customContent }));

    assert.deepEqual(
      (await createContentStorage(directory).readPublished()).content.appearance,
      customContent.appearance,
    );
  });
});

test("invalid appearance blocks startup safely", async () => {
  await withTemporaryDirectory(async (directory) => {
    const storage = createContentStorage(directory);
    await storage.initialize(defaultSiteContent);

    for (const appearance of [
      {
        ...defaultSiteAppearance,
        palette: { ...defaultSiteAppearance.palette, primary: "red" },
      },
      {
        ...defaultSiteAppearance,
        palette: { ...defaultSiteAppearance.palette, text: "#F5F4F1" },
      },
      {
        ...defaultSiteAppearance,
        extra: "#FFFFFF",
      },
    ]) {
      await writeFile(
        join(directory, "published.json"),
        `${JSON.stringify({
          ...createPublished(),
          content: { ...defaultSiteContent, appearance },
        })}\n`,
        "utf8",
      );
      await assert.rejects(
        () => createContentStorage(directory).initialize(defaultSiteContent),
        (error: unknown) =>
          error instanceof StorageError &&
          error.code === "STORAGE_VALIDATION_FAILED",
      );
    }
  });
});
