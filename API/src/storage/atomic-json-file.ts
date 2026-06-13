import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StorageError } from "./storage-errors";

export async function writeJsonFileAtomically(
  targetPath: string,
  payload: unknown,
): Promise<void> {
  const directory = dirname(targetPath);
  const temporaryPath = join(
    directory,
    `.${targetPath.split(/[\\/]/).pop()}.${process.pid}.${randomUUID()}.tmp`,
  );

  let handle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    await mkdir(directory, { recursive: true });
    handle = await open(temporaryPath, "wx");
    await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new StorageError(
      "STORAGE_WRITE_FAILED",
      "Failed to write atomic JSON temporary file.",
      { cause: error },
    );
  }

  try {
    await rename(temporaryPath, targetPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw new StorageError(
      "STORAGE_RENAME_FAILED",
      "Failed to rename atomic JSON temporary file.",
      { cause: error },
    );
  }
}
