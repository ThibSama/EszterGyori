import "server-only";

import { scrypt, timingSafeEqual, randomBytes } from "node:crypto";

export const SCRYPT_HASH_VERSION = "scrypt-v1";
export const SCRYPT_COST = 16_384;
export const SCRYPT_BLOCK_SIZE = 8;
export const SCRYPT_PARALLELIZATION = 1;
export const SCRYPT_KEY_LENGTH = 64;
export const SCRYPT_SALT_BYTES = 16;

interface ParsedScryptHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  hash: Buffer;
}

export function isPasswordAllowedForHashGeneration(password: string): boolean {
  return password.length > 0;
}

export async function generateScryptPasswordHash(
  password: string,
): Promise<string> {
  if (!isPasswordAllowedForHashGeneration(password)) {
    throw new Error("Le mot de passe ne peut pas etre vide.");
  }

  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = await derivePasswordHash(password, {
    cost: SCRYPT_COST,
    blockSize: SCRYPT_BLOCK_SIZE,
    parallelization: SCRYPT_PARALLELIZATION,
    salt,
    hash: Buffer.alloc(SCRYPT_KEY_LENGTH),
  });

  return [
    SCRYPT_HASH_VERSION,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  const parsed = parseScryptPasswordHash(encodedHash);
  if (!parsed) return false;

  const candidate = await derivePasswordHash(password, parsed);
  if (candidate.byteLength !== parsed.hash.byteLength) return false;

  return timingSafeEqual(candidate, parsed.hash);
}

export function parseScryptPasswordHash(
  encodedHash: string,
): ParsedScryptHash | null {
  const parts = encodedHash.split("$");
  if (parts.length !== 6) return null;

  const [version, cost, blockSize, parallelization, salt, hash] = parts;
  if (version !== SCRYPT_HASH_VERSION) return null;
  if (!cost || !blockSize || !parallelization || !salt || !hash) return null;
  if (!/^\d+$/.test(cost) || !/^\d+$/.test(blockSize)) return null;
  if (!/^\d+$/.test(parallelization)) return null;

  const parsedCost = Number(cost);
  const parsedBlockSize = Number(blockSize);
  const parsedParallelization = Number(parallelization);

  if (
    parsedCost !== SCRYPT_COST ||
    parsedBlockSize !== SCRYPT_BLOCK_SIZE ||
    parsedParallelization !== SCRYPT_PARALLELIZATION
  ) {
    return null;
  }

  if (!isBase64Url(salt) || !isBase64Url(hash)) return null;

  const saltBuffer = Buffer.from(salt, "base64url");
  const hashBuffer = Buffer.from(hash, "base64url");
  if (saltBuffer.byteLength < SCRYPT_SALT_BYTES) return null;
  if (hashBuffer.byteLength !== SCRYPT_KEY_LENGTH) return null;

  return {
    cost: parsedCost,
    blockSize: parsedBlockSize,
    parallelization: parsedParallelization,
    salt: saltBuffer,
    hash: hashBuffer,
  };
}

async function derivePasswordHash(
  password: string,
  parsed: ParsedScryptHash,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      parsed.salt,
      SCRYPT_KEY_LENGTH,
      {
        N: parsed.cost,
        r: parsed.blockSize,
        p: parsed.parallelization,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(Buffer.from(derivedKey));
      },
    );
  });
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}
