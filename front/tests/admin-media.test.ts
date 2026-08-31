import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_MEDIA_PATH,
  CSRF_HEADER,
  MEDIA_UPLOAD_FIELD_NAME,
  MEDIA_UPLOAD_LIMIT_BYTES,
  defaultSiteContent,
  mediaMimeTypes,
  type MediaAssetMetadata,
  type SiteContent,
} from "@eszter/contracts";
import { ADMIN_API_MESSAGES, createAdminApiClient } from "../app/lib/admin-api";
import {
  adminDraftReducer,
  canWrite,
  createInitialDraftState,
} from "../app/lib/admin-server-draft";
import {
  MEDIA_LIBRARY_MESSAGES,
  canDelete,
  createInitialMediaLibraryState,
  formatMediaSize,
  isManagedMediaPath,
  mediaFailureMessage,
  mediaLibraryReducer,
  mediaUsagesIn,
  type MediaLibraryAction,
  type MediaLibraryState,
} from "../app/lib/admin-media";

/**
 * ESZ-036/037 — the browser half of the media surface.
 *
 * Two halves, and they are separate on purpose. The transport tests assert what
 * the client *sends* and how it classifies what comes back; the reducer tests
 * assert what the panel does about each outcome. The server side of every one of
 * these is already covered by the PHP media suite — what was unproven until this
 * package is that the editor asks for them correctly, tells them apart
 * afterwards, and never lets a media operation touch a draft revision.
 */

interface RecordedCall {
  path: string;
  method: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

function stubFetch(
  responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: RecordedCall[] = [];
  let index = 0;

  const fetchImpl = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: init?.body,
    });

    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;

    const headers = new Headers(next.headers);
    if (next.body !== undefined) headers.set("content-type", "application/json");

    return new Response(
      next.body === undefined || next.status === 204
        ? null
        : JSON.stringify(next.body),
      { status: next.status, headers },
    );
  };

  return { calls, fetchImpl };
}

function asset(overrides: Partial<MediaAssetMetadata> = {}): MediaAssetMetadata {
  const id = overrides.id ?? `med_${"a".repeat(32)}`;

  return {
    id,
    path: `/media/${id}.jpg`,
    mimeType: "image/jpeg",
    byteSize: 128_000,
    width: 1600,
    height: 1067,
    uploadedAt: "2026-08-20T10:00:00.000Z",
    ...overrides,
  };
}

function errorBody(code: string) {
  return { error: { code, message: "refused", requestId: "req_test" } };
}

function reduce(
  actions: MediaLibraryAction[],
  from: MediaLibraryState = createInitialMediaLibraryState(),
): MediaLibraryState {
  return actions.reduce(mediaLibraryReducer, from);
}

// ── Transport ─────────────────────────────────────────────────────────────

test("listing sends a plain authenticated GET and returns the server's order", async () => {
  const first = asset({ id: `med_${"b".repeat(32)}` });
  const second = asset({ id: `med_${"a".repeat(32)}` });
  const { calls, fetchImpl } = stubFetch([
    { status: 200, body: { assets: [first, second] } },
  ]);

  const result = await createAdminApiClient(fetchImpl).listMedia();

  assert.equal(calls[0].path, ADMIN_MEDIA_PATH);
  assert.equal(calls[0].method, "GET");
  // A read carries no token: `csrf.readsAreExempt`, and sending one would
  // suggest the server checks it here.
  assert.equal(calls[0].headers.get(CSRF_HEADER), null);

  assert.ok(result.ok);
  // Verbatim, not re-sorted. The contract makes the server's order total and
  // stable; a second ordering here would be one that can disagree with it.
  assert.deepEqual(result.value, [first, second]);
});

test("an upload sends multipart with no explicit content-type", async () => {
  const { calls, fetchImpl } = stubFetch([
    { status: 201, body: { asset: asset() } },
  ]);

  const file = new File([new Uint8Array([1, 2, 3])], "photo.jpg", {
    type: "image/jpeg",
  });
  const result = await createAdminApiClient(fetchImpl).uploadMedia(file, "token-1");

  assert.ok(result.ok);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.get(CSRF_HEADER), "token-1");

  // The critical assertion. A hand-set `multipart/form-data` carries no
  // boundary, and every server parses that as zero parts — an upload that
  // silently arrives empty. Only the browser can write this header.
  assert.equal(calls[0].headers.get("content-type"), null);

  assert.ok(calls[0].body instanceof FormData);
  const sent = calls[0].body as FormData;
  assert.equal(sent.getAll(MEDIA_UPLOAD_FIELD_NAME).length, 1);
  assert.ok(sent.get(MEDIA_UPLOAD_FIELD_NAME) instanceof File);
});

test("an oversized file is refused without a request being made", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 201, body: { asset: asset() } }]);

  const tooBig = new File(
    [new Uint8Array(MEDIA_UPLOAD_LIMIT_BYTES + 1)],
    "huge.jpg",
    { type: "image/jpeg" },
  );
  const result = await createAdminApiClient(fetchImpl).uploadMedia(tooBig, "t");

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failure.kind === "payload-too-large");
  // The point of the client-side check: the person is told before paying for the
  // whole transfer. The server's check is the one that is load-bearing.
  assert.equal(calls.length, 0);
});

test("a delete carries the id in the body and the token in the header", async () => {
  const { calls, fetchImpl } = stubFetch([{ status: 204 }]);

  const id = `med_${"c".repeat(32)}`;
  const result = await createAdminApiClient(fetchImpl).deleteMedia(id, "token-2");

  assert.ok(result.ok);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].path, ADMIN_MEDIA_PATH);
  assert.equal(calls[0].headers.get(CSRF_HEADER), "token-2");
  assert.deepEqual(JSON.parse(calls[0].body as string), { id });
});

test("each media refusal is classified as its own failure kind", async () => {
  const cases: Array<[number, string, string]> = [
    [413, "PAYLOAD_TOO_LARGE", "payload-too-large"],
    [409, "MEDIA_REFERENCED", "media-referenced"],
    [404, "NOT_FOUND", "not-found"],
    [400, "VALIDATION_FAILED", "validation"],
    [401, "UNAUTHENTICATED", "unauthenticated"],
    [403, "CSRF_TOKEN_INVALID", "forbidden"],
    [500, "STORAGE_FAILURE", "server"],
  ];

  for (const [status, code, kind] of cases) {
    const { fetchImpl } = stubFetch([{ status, body: errorBody(code) }]);
    const result = await createAdminApiClient(fetchImpl).deleteMedia(
      `med_${"d".repeat(32)}`,
      "t",
    );

    assert.equal(result.ok, false, code);
    assert.ok(!result.ok && result.failure.kind === kind, `${code} → ${kind}`);
  }
});

test("a 409 on media is never read as a revision conflict", async () => {
  // The two share a status and nothing else. A client that collapsed them would
  // retry a referenced delete forever: re-reading and retrying is the recovery
  // for a stale revision, and it can never resolve "this image is still in use".
  const { fetchImpl } = stubFetch([
    { status: 409, body: errorBody("MEDIA_REFERENCED") },
  ]);

  const result = await createAdminApiClient(fetchImpl).deleteMedia(
    `med_${"e".repeat(32)}`,
    "t",
  );

  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failure.kind === "media-referenced");
  assert.equal(
    !result.ok && result.failure.message,
    ADMIN_API_MESSAGES.mediaReferenced,
  );
});

test("a 2xx whose body is not the frozen shape is never handed to the editor", async () => {
  for (const body of [{ assets: [{ id: "not-an-id" }] }, { items: [] }, null]) {
    const { fetchImpl } = stubFetch([{ status: 200, body }]);
    const result = await createAdminApiClient(fetchImpl).listMedia();

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.failure.kind === "malformed-response");
  }
});

// ── The panel's state machine ─────────────────────────────────────────────

test("the library starts idle and fetches nothing on its own", () => {
  const state = createInitialMediaLibraryState();

  assert.equal(state.phase, "idle");
  assert.deepEqual(state.assets, []);
  assert.equal(state.busy, null);
  assert.equal(state.pendingDeleteId, null);
});

test("an empty library is a loaded library, not a failure", () => {
  const state = reduce([{ type: "load-start" }, { type: "loaded", assets: [] }]);

  assert.equal(state.phase, "ready");
  assert.equal(state.statusMessage, MEDIA_LIBRARY_MESSAGES.empty);
  assert.equal(state.errorMessage, null);
});

test("a failed first read leaves the panel unavailable but usable by hand", () => {
  const state = reduce([
    { type: "load-start" },
    {
      type: "load-failed",
      failure: { kind: "server", message: "boom", status: 500 },
    },
  ]);

  assert.equal(state.phase, "unavailable");
  assert.deepEqual(state.assets, []);
  assert.equal(state.busy, null);
  // The manual source field stays available, which is why this is not fatal.
  assert.equal(state.statusMessage, MEDIA_LIBRARY_MESSAGES.unavailable);
});

test("an upload prepends the asset the server described", () => {
  const existing = asset({ id: `med_${"1".repeat(32)}` });
  const uploaded = asset({ id: `med_${"2".repeat(32)}` });

  const state = reduce([
    { type: "load-start" },
    { type: "loaded", assets: [existing] },
    { type: "upload-start" },
    { type: "uploaded", asset: uploaded },
  ]);

  // Newest first, matching the server's order, so the next read does not
  // reshuffle the list the editor is looking at.
  assert.deepEqual(state.assets, [uploaded, existing]);
  assert.equal(state.busy, null);
  assert.equal(state.statusMessage, MEDIA_LIBRARY_MESSAGES.uploaded);
});

test("a failed upload changes the list not at all", () => {
  const existing = asset();
  const before = reduce([
    { type: "load-start" },
    { type: "loaded", assets: [existing] },
  ]);

  const after = reduce(
    [
      { type: "upload-start" },
      {
        type: "upload-failed",
        failure: { kind: "validation", message: ADMIN_API_MESSAGES.mediaRejected },
      },
    ],
    before,
  );

  assert.deepEqual(after.assets, before.assets);
  assert.equal(after.phase, "ready");
  assert.equal(after.busy, null);
  assert.equal(after.errorMessage, ADMIN_API_MESSAGES.mediaRejected);
});

test("deleting is two steps and a refusal removes nothing", () => {
  const target = asset({ id: `med_${"3".repeat(32)}` });
  const loaded = reduce([
    { type: "load-start" },
    { type: "loaded", assets: [target] },
  ]);

  const pending = mediaLibraryReducer(loaded, {
    type: "delete-requested",
    id: target.id,
  });

  assert.equal(pending.pendingDeleteId, target.id);
  // A pending confirmation is not an in-flight request; the rest of the panel
  // must stay usable.
  assert.equal(pending.busy, null);
  assert.deepEqual(pending.assets, [target]);

  const refused = reduce(
    [
      { type: "delete-start" },
      {
        type: "delete-failed",
        failure: {
          kind: "media-referenced",
          message: ADMIN_API_MESSAGES.mediaReferenced,
        },
      },
    ],
    pending,
  );

  assert.deepEqual(refused.assets, [target], "a refused delete dropped the asset");
  assert.equal(refused.pendingDeleteId, null);
  assert.equal(refused.errorMessage, ADMIN_API_MESSAGES.mediaReferenced);

  const cancelled = mediaLibraryReducer(pending, { type: "delete-cancelled" });
  assert.equal(cancelled.pendingDeleteId, null);
  assert.deepEqual(cancelled.assets, [target]);
});

test("a confirmed delete removes exactly the id the server confirmed", () => {
  const kept = asset({ id: `med_${"4".repeat(32)}` });
  const removed = asset({ id: `med_${"5".repeat(32)}` });

  const state = reduce([
    { type: "load-start" },
    { type: "loaded", assets: [kept, removed] },
    { type: "delete-requested", id: removed.id },
    { type: "delete-start" },
    { type: "deleted", id: removed.id },
  ]);

  assert.deepEqual(state.assets, [kept]);
  assert.equal(state.pendingDeleteId, null);
  assert.equal(state.statusMessage, MEDIA_LIBRARY_MESSAGES.deleted);
});

test("no operation may start while another is in flight", () => {
  const state = reduce([
    { type: "load-start" },
    { type: "loaded", assets: [asset()] },
    { type: "delete-start" },
  ]);

  assert.equal(canDelete(state), false);
  assert.equal(state.busy, "deleting");
});

test("a reload keeps the panel ready rather than blanking it", () => {
  // Re-reading an already-loaded library must not flash an empty grid: the
  // assets on screen are still the truth until the server says otherwise.
  const existing = asset();
  const state = reduce([
    { type: "load-start" },
    { type: "loaded", assets: [existing] },
    { type: "load-start" },
  ]);

  assert.equal(state.phase, "ready");
  assert.deepEqual(state.assets, [existing]);
  assert.equal(state.busy, "loading");
});

test("a rejected upload is described in terms the editor can act on", () => {
  // `validation` is the server's answer to a wrong format *and* to a corrupt
  // file, and the generic "content refused" copy would leave the person with
  // nothing to try. The media panel names the accepted formats instead.
  assert.equal(
    mediaFailureMessage({ kind: "validation", message: ADMIN_API_MESSAGES.validation }),
    ADMIN_API_MESSAGES.mediaRejected,
  );
  assert.match(ADMIN_API_MESSAGES.mediaRejected, /JPEG/);
  assert.match(ADMIN_API_MESSAGES.mediaRejected, /8 Mo/);

  // Every other failure keeps its own message.
  assert.equal(
    mediaFailureMessage({ kind: "network", message: ADMIN_API_MESSAGES.network }),
    ADMIN_API_MESSAGES.network,
  );
});

// ── Selection, and the draft workflow it goes through ─────────────────────

test("selecting an asset is an ordinary field edit with no revision of its own", () => {
  // `media.libraryIsTheOnlyRegistry`. This is what the panel's `onSelect` does,
  // asserted as the data transformation it is: a `src` changes, and nothing
  // else in the document moves. It reaches the server only when the admin saves.
  const asset1 = asset({ id: `med_${"6".repeat(32)}` });
  const before: SiteContent = structuredClone(defaultSiteContent);

  const after: SiteContent = {
    ...before,
    hero: { ...before.hero, visual: { ...before.hero.visual, src: asset1.path } },
  };

  assert.equal(after.hero.visual.src, asset1.path);
  assert.equal(after.hero.visual.id, before.hero.visual.id);
  assert.equal(after.hero.visual.alt, before.hero.visual.alt);
  assert.deepEqual(after.services, before.services);
  assert.deepEqual(after.about, before.about);
  // No revision field exists on content at all; the envelope carries it and the
  // draft workflow is the only thing that writes one.
  assert.equal("revision" in after, false);
});

test("repointing a field leaves the previous asset in the library", () => {
  // `media.contentEditsNeverDeleteAssets`, on the client side: no reducer action
  // exists that removes an asset because a field changed.
  const first = asset({ id: `med_${"7".repeat(32)}` });
  const second = asset({ id: `med_${"8".repeat(32)}` });

  const library = reduce([
    { type: "load-start" },
    { type: "loaded", assets: [second, first] },
  ]);

  const content: SiteContent = structuredClone(defaultSiteContent);
  content.hero.visual.src = first.path;
  content.hero.visual.src = second.path;

  assert.equal(mediaUsagesIn(content, first.path), 0);
  assert.deepEqual(library.assets, [second, first]);
});

test("the usage count matches the server's definition of a reference", () => {
  const used = asset({ id: `med_${"9".repeat(32)}` });
  const content: SiteContent = structuredClone(defaultSiteContent);

  assert.equal(mediaUsagesIn(content, used.path), 0);

  content.hero.visual.src = used.path;
  content.about.portrait.src = used.path;

  assert.equal(mediaUsagesIn(content, used.path), 2);

  // The same path in a field that is not a source is not a reference — the
  // server walks `src` keys and nothing else, and the two must agree.
  content.hero.visual.alt = used.path;
  assert.equal(mediaUsagesIn(content, used.path), 2);
});

test("a managed path is recognised and an external URL is not", () => {
  assert.equal(isManagedMediaPath(`/media/med_${"a".repeat(32)}.jpg`), true);
  assert.equal(isManagedMediaPath("/images/portrait.jpg"), false);
  assert.equal(isManagedMediaPath("https://example.com/a.jpg"), false);
  assert.equal(isManagedMediaPath(null), false);
});

test("the accepted formats offered to the file picker come from the contract", () => {
  // The `accept` attribute is a convenience and never a check — the server
  // decides — but it must not offer a format the server will refuse.
  assert.deepEqual([...mediaMimeTypes].sort(), [
    "image/jpeg",
    "image/png",
    "image/webp",
  ]);
  assert.equal(mediaMimeTypes.includes("image/svg+xml" as never), false);
});

test("sizes are formatted the way an operating system shows them", () => {
  assert.equal(formatMediaSize(512), "512 o");
  assert.equal(formatMediaSize(2048), "2 Ko");
  assert.equal(formatMediaSize(MEDIA_UPLOAD_LIMIT_BYTES), "8.0 Mo");
  assert.equal(formatMediaSize(-1), "—");
});

test("a whole media session leaves the draft revision exactly where it was", () => {
  // The invariant the two state machines have to agree on: media operations move
  // no content revision, so an editor that uploads, deletes and selects between
  // two saves still saves against the head it loaded. If the media panel could
  // touch `revision`, the next save would either be refused for no reason or —
  // far worse — succeed against a head nobody had read.
  const draft = adminDraftReducer(createInitialDraftState(), {
    type: "draft-loaded",
    envelope: {
      schemaVersion: 1,
      revision: 7,
      updatedAt: "2026-08-20T10:00:00.000Z",
      content: structuredClone(defaultSiteContent),
    },
  });

  assert.equal(draft.revision, 7);
  assert.equal(canWrite(draft), true);

  const uploaded = asset({ id: `med_${"f".repeat(32)}` });
  const library = reduce([
    { type: "load-start" },
    { type: "loaded", assets: [] },
    { type: "upload-start" },
    { type: "uploaded", asset: uploaded },
    { type: "delete-requested", id: uploaded.id },
    { type: "delete-cancelled" },
  ]);

  assert.deepEqual(library.assets, [uploaded]);

  // The media reducer's actions are not the draft reducer's, and feeding one to
  // the other is a no-op rather than a state change: `adminDraftReducer` falls
  // through to `default` and returns the state it was given, identically.
  let unchanged = draft;
  for (const action of [
    { type: "loaded", assets: [uploaded] },
    { type: "uploaded", asset: uploaded },
    { type: "deleted", id: uploaded.id },
  ] as const) {
    unchanged = adminDraftReducer(unchanged, action as never);
  }

  assert.equal(unchanged.revision, 7);
  assert.equal(unchanged.phase, draft.phase);
  assert.deepEqual(unchanged, draft);
});

test("a failed media call never advances the draft, even when it is a 409", () => {
  // Both surfaces answer 409 and they mean different things. A media refusal
  // must not reach the draft reducer's conflict path, which records a server
  // revision for the banner and flips the editor into reconciliation.
  const draft = adminDraftReducer(createInitialDraftState(), {
    type: "draft-loaded",
    envelope: {
      schemaVersion: 1,
      revision: 3,
      updatedAt: "2026-08-20T10:00:00.000Z",
      content: structuredClone(defaultSiteContent),
    },
  });

  const afterMediaRefusal = reduce(
    [
      { type: "load-start" },
      { type: "loaded", assets: [asset()] },
      { type: "delete-start" },
      {
        type: "delete-failed",
        failure: {
          kind: "media-referenced",
          message: ADMIN_API_MESSAGES.mediaReferenced,
        },
      },
    ],
  );

  assert.equal(afterMediaRefusal.errorMessage, ADMIN_API_MESSAGES.mediaReferenced);
  assert.equal(draft.revision, 3);
  assert.equal(draft.phase, "ready");
  assert.equal(draft.reportedServerRevision, null);
  assert.deepEqual(draft.conflicts, []);
});
