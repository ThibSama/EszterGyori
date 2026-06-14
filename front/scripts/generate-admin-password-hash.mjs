import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { promisify } from "node:util";

const SCRYPT_VERSION = "scrypt-v1";
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELIZATION = 1;
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_SALT_BYTES = 16;

const scrypt = promisify(scryptCallback);

async function generateScryptPasswordHash(password) {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derivedKey = await scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_COST,
    r: SCRYPT_BLOCK_SIZE,
    p: SCRYPT_PARALLELIZATION,
    maxmem: 64 * 1024 * 1024,
  });

  return [
    SCRYPT_VERSION,
    String(SCRYPT_COST),
    String(SCRYPT_BLOCK_SIZE),
    String(SCRYPT_PARALLELIZATION),
    salt.toString("base64url"),
    Buffer.from(derivedKey).toString("base64url"),
  ].join("$");
}

function createMutedOutput() {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

async function promptHidden(query) {
  const rl = createInterface({
    input: process.stdin,
    output: createMutedOutput(),
    terminal: true,
  });

  process.stdout.write(query);
  const value = await rl.question("");
  process.stdout.write("\n");
  rl.close();
  return value;
}

async function readPipedPasswords() {
  const chunks = [];

  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }

  const [password = "", confirmation = ""] = Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/);

  return { password, confirmation };
}

const { password, confirmation } = process.stdin.isTTY
  ? {
      password: await promptHidden("Mot de passe admin: "),
      confirmation: await promptHidden("Confirmer le mot de passe admin: "),
    }
  : await readPipedPasswords();

if (!password) {
  console.error("Le mot de passe ne peut pas etre vide.");
  process.exit(1);
}

if (password !== confirmation) {
  console.error("Les mots de passe ne correspondent pas.");
  process.exit(1);
}

if (password.length < 14) {
  console.warn("Recommandation: utilisez au moins 14 caracteres.");
}

const hash = await generateScryptPasswordHash(password);

console.log("\nHash ADMIN_PASSWORD_HASH:");
console.log(hash);
console.log("\nConfiguration:");
console.log("1. Copiez cette valeur dans ADMIN_PASSWORD_HASH.");
console.log("2. Ne stockez jamais le mot de passe en clair.");
console.log(
  "3. Generez ADMIN_SESSION_SECRET avec: node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"",
);
