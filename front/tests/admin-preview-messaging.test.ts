import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteContent } from "@eszter/contracts";
import {
  ADMIN_PREVIEW_CONTENT_MESSAGE,
  createAdminPreviewContentMessage,
  parseAdminPreviewContentMessage,
} from "../app/lib/admin-preview-messaging";

const expectedOrigin = "https://eszter.example";
const expectedSource = { name: "parent-window" };

test("preview messaging accepts valid same-origin content", () => {
  const result = parseAdminPreviewContentMessage(
    {
      data: createAdminPreviewContentMessage(defaultSiteContent),
      origin: expectedOrigin,
      source: expectedSource,
    },
    expectedOrigin,
    expectedSource,
  );

  assert.equal(result.status, "accepted");
  if (result.status === "accepted") {
    assert.deepEqual(result.content, defaultSiteContent);
  }
});

test("preview messaging rejects malformed content", () => {
  const message = createAdminPreviewContentMessage(defaultSiteContent);
  const result = parseAdminPreviewContentMessage(
    {
      data: {
        ...message,
        content: { ...message.content, navigation: { links: [] } },
      },
      origin: expectedOrigin,
      source: expectedSource,
    },
    expectedOrigin,
    expectedSource,
  );

  assert.equal(result.status, "rejected");
});

test("preview messaging rejects wrong origin or source", () => {
  assert.equal(
    parseAdminPreviewContentMessage(
      {
        data: createAdminPreviewContentMessage(defaultSiteContent),
        origin: "https://evil.example",
        source: expectedSource,
      },
      expectedOrigin,
      expectedSource,
    ).status,
    "rejected",
  );

  assert.equal(
    parseAdminPreviewContentMessage(
      {
        data: createAdminPreviewContentMessage(defaultSiteContent),
        origin: expectedOrigin,
        source: { name: "other-window" },
      },
      expectedOrigin,
      expectedSource,
    ).status,
    "rejected",
  );
});

test("preview messaging ignores unrelated message types", () => {
  const result = parseAdminPreviewContentMessage(
    {
      data: { type: "OTHER_MESSAGE", content: defaultSiteContent },
      origin: expectedOrigin,
      source: expectedSource,
    },
    expectedOrigin,
    expectedSource,
  );

  assert.equal(result.status, "ignored");
});

test("preview content message carries content only and no session secret", () => {
  const message = createAdminPreviewContentMessage(defaultSiteContent);
  const serialized = JSON.stringify(message);

  assert.deepEqual(Object.keys(message).sort(), ["content", "type"]);
  assert.equal(message.type, ADMIN_PREVIEW_CONTENT_MESSAGE);
  assert.equal(serialized.includes("ADMIN_SESSION_SECRET"), false);
  assert.equal(serialized.includes("eszter_admin_session"), false);
  assert.equal(serialized.includes("token"), false);
  assert.equal(serialized.includes("secret"), false);
});
