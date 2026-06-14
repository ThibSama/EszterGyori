import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { SignJWT } from "jose";
import {
  generateScryptPasswordHash,
  isPasswordAllowedForHashGeneration,
  verifyPassword,
} from "../app/lib/auth/password";
import {
  ADMIN_SESSION_AUDIENCE,
  ADMIN_SESSION_ISSUER,
  ADMIN_SESSION_ROLE,
  ADMIN_SESSION_SUBJECT,
  createAdminSessionToken,
  verifyAdminSessionToken,
} from "../app/lib/auth/session-token";
import { sanitizeAdminRedirect } from "../app/lib/auth/safe-redirect";
import { loadAdminAuthConfig } from "../app/lib/auth/config";

const validConfig = {
  username: "admin",
  passwordHash: "unused",
  sessionSecret: "abcdefghijklmnopqrstuvwxyzABCDEF",
  sessionTtlSeconds: 28_800,
};

test("password hashing verifies the original password and rejects wrong values", async () => {
  const hash = await generateScryptPasswordHash("correct horse battery");

  assert.equal(await verifyPassword("correct horse battery", hash), true);
  assert.equal(await verifyPassword("wrong password", hash), false);
  assert.equal(await verifyPassword("correct horse battery", "not-a-hash"), false);
  assert.equal(
    await verifyPassword(
      "correct horse battery",
      hash.replace("scrypt-v1", "scrypt-v2"),
    ),
    false,
  );
  assert.equal(
    await verifyPassword(
      "correct horse battery",
      hash.replace(/(\$)([A-Za-z0-9_-])([A-Za-z0-9_-]+)$/, (_match, separator, first, rest) => {
        return `${separator}${first === "A" ? "B" : "A"}${rest}`;
      }),
    ),
    false,
  );
  assert.equal(isPasswordAllowedForHashGeneration(""), false);
  assert.equal(
    await verifyPassword(
      "correct horse battery",
      "scrypt-v1$16384$8$1$c2FsdA$aGFzaA",
    ),
    false,
  );
});

test("session tokens verify expected claims and reject invalid tokens", async () => {
  const token = await createAdminSessionToken(validConfig, new Date("2026-06-14T10:00:00.000Z"));
  const session = await verifyAdminSessionToken(token, validConfig, {
    currentDate: new Date("2026-06-14T10:01:00.000Z"),
  });

  assert.equal(session?.sub, ADMIN_SESSION_SUBJECT);
  assert.equal(session?.role, ADMIN_SESSION_ROLE);
  assert.equal(typeof session?.jti, "string");
  assert.equal(session?.iat, 1781431200);
  assert.equal(session?.exp, 1781460000);

  assert.equal(
    await verifyAdminSessionToken(token, validConfig, {
      currentDate: new Date("2026-06-14T19:00:01.000Z"),
    }),
    null,
  );
  assert.equal(await verifyAdminSessionToken(`${token}x`, validConfig), null);
  assert.equal(
    await verifyAdminSessionToken(token, {
      ...validConfig,
      sessionSecret: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef",
    }),
    null,
  );
  assert.equal(await verifyAdminSessionToken("malformed", validConfig), null);
});

test("session token rejects wrong issuer, audience, role and missing claims", async () => {
  const secret = new TextEncoder().encode(validConfig.sessionSecret);
  const baseClaims = {
    sub: ADMIN_SESSION_SUBJECT,
    role: ADMIN_SESSION_ROLE,
    jti: "test-jti",
  };

  const wrongIssuer = await new SignJWT(baseClaims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("other")
    .setAudience(ADMIN_SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  assert.equal(await verifyAdminSessionToken(wrongIssuer, validConfig), null);

  const wrongAudience = await new SignJWT(baseClaims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ADMIN_SESSION_ISSUER)
    .setAudience("other")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  assert.equal(await verifyAdminSessionToken(wrongAudience, validConfig), null);

  const wrongRole = await new SignJWT({ ...baseClaims, role: "editor" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ADMIN_SESSION_ISSUER)
    .setAudience(ADMIN_SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  assert.equal(await verifyAdminSessionToken(wrongRole, validConfig), null);

  const missingClaims = await new SignJWT({
    sub: ADMIN_SESSION_SUBJECT,
    role: ADMIN_SESSION_ROLE,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ADMIN_SESSION_ISSUER)
    .setAudience(ADMIN_SESSION_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(secret);
  assert.equal(await verifyAdminSessionToken(missingClaims, validConfig), null);
});

test("safe admin redirects reject open redirects and auth handlers", () => {
  assert.equal(sanitizeAdminRedirect("/admin"), "/admin");
  assert.equal(sanitizeAdminRedirect("/admin/section?x=1"), "/admin/section?x=1");
  assert.equal(sanitizeAdminRedirect("https://example.com"), "/admin");
  assert.equal(sanitizeAdminRedirect("//example.com"), "/admin");
  assert.equal(sanitizeAdminRedirect("/admin/login"), "/admin");
  assert.equal(sanitizeAdminRedirect("/admin/auth/login"), "/admin");
  assert.equal(sanitizeAdminRedirect(null), "/admin");
});

test("admin auth configuration validates explicit environments", () => {
  const hash = "scrypt-v1$16384$8$1$c2FsdF9zYWx0X3NhbHQ$CzjM0q0kOCeK4Hu9LhXvtBxuG7_e7MX63mdLQ0U8ji9z5CgAo_g9zdv4G3ErmcT8UX8cW1cKZJGgOGp0xVRUlA";
  const environment = {
    ADMIN_USERNAME: " admin ",
    ADMIN_PASSWORD_HASH: hash,
    ADMIN_SESSION_SECRET: "abcdefghijklmnopqrstuvwxyzABCDEF",
    ADMIN_SESSION_TTL_SECONDS: "900",
  };

  assert.deepEqual(loadAdminAuthConfig(environment), {
    username: "admin",
    passwordHash: hash,
    sessionSecret: "abcdefghijklmnopqrstuvwxyzABCDEF",
    sessionTtlSeconds: 900,
  });

  assert.throws(() => loadAdminAuthConfig({ ...environment, ADMIN_USERNAME: "" }));
  assert.throws(() =>
    loadAdminAuthConfig({ ...environment, ADMIN_PASSWORD_HASH: "" }),
  );
  assert.throws(() =>
    loadAdminAuthConfig({ ...environment, ADMIN_SESSION_SECRET: "" }),
  );
  assert.throws(() =>
    loadAdminAuthConfig({ ...environment, ADMIN_SESSION_SECRET: "short" }),
  );
  assert.throws(() =>
    loadAdminAuthConfig({ ...environment, ADMIN_SESSION_TTL_SECONDS: "10" }),
  );
  assert.throws(() => loadAdminAuthConfig({}));
});

test("logout remains POST-only", () => {
  const source = readFileSync(
    resolve(process.cwd(), "app/admin/auth/logout/route.ts"),
    "utf8",
  );

  assert.match(source, /export\s+async\s+function\s+POST\b/);
  assert.doesNotMatch(source, /export\s+async\s+function\s+GET\b/);
});

test("admin preview route is covered by admin authentication", () => {
  const previewRoute = resolve(
    process.cwd(),
    "app/admin/preview/page.tsx",
  );
  const proxySource = readFileSync(resolve(process.cwd(), "proxy.ts"), "utf8");
  const previewSource = readFileSync(previewRoute, "utf8");

  assert.equal(existsSync(previewRoute), true);
  assert.match(proxySource, /matcher:\s*\[\s*"\/admin\/:path\*"\s*\]/);
  assert.match(previewSource, /requireAdminSession\(\)/);
});
