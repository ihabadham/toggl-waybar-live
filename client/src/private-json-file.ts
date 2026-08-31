import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface PrivateJsonFileOptions {
  directoryDescription: string;
  maximumBytes: number;
  targetDescription: string;
  temporaryPrefix: string;
}

async function pathIsSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function writePrivateJson(
  path: string,
  value: unknown,
  options: Pick<
    PrivateJsonFileOptions,
    "directoryDescription" | "targetDescription" | "temporaryPrefix"
  >,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink()) {
    throw new Error(`${options.directoryDescription} must not be a symlink`);
  }
  await chmod(directory, 0o700);
  if (await pathIsSymlink(path)) {
    throw new Error(`${options.targetDescription} must not be a symlink`);
  }

  const temporaryPath = join(
    directory,
    `.${options.temporaryPrefix}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let temporaryCreated = false;
  try {
    const file = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      await file.chmod(0o600);
      await file.writeFile(JSON.stringify(value), "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    if (await pathIsSymlink(path)) {
      throw new Error(`${options.targetDescription} must not be a symlink`);
    }
    await rename(temporaryPath, path);
    temporaryCreated = false;

    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryCreated) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}

export async function readPrivateJson<T>(
  path: string,
  options: Pick<PrivateJsonFileOptions, "maximumBytes">,
  parse: (value: unknown) => T,
): Promise<T | null> {
  try {
    if ((await pathIsSymlink(dirname(path))) || (await pathIsSymlink(path))) {
      return null;
    }
    const metadata = await stat(path);
    if (!metadata.isFile() || metadata.size > options.maximumBytes) {
      return null;
    }
    return parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}
