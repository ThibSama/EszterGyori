import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteContent } from "@eszter/contracts";
import {
  COMPLETE_RESET_SUCCESS_MESSAGE,
  createCompleteResetState,
} from "../app/lib/admin-content-reset";

test("complete reset restores canonical content and clean local state", () => {
  const result = createCompleteResetState(defaultSiteContent, { ok: true });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(result.state.content, defaultSiteContent);
  assert.deepEqual(result.state.cleanContent, defaultSiteContent);
  assert.notEqual(result.state.content, defaultSiteContent);
  assert.notEqual(result.state.cleanContent, defaultSiteContent);
  assert.equal(result.state.isDirty, false);
  assert.equal(result.state.draftSavedAt, null);
  assert.equal(result.state.hasInvalidStoredDraft, false);
  assert.equal(result.state.errorMessage, null);
  assert.equal(result.state.statusMessage, COMPLETE_RESET_SUCCESS_MESSAGE);
});

test("complete reset failure is not reported as success", () => {
  const result = createCompleteResetState(defaultSiteContent, {
    ok: false,
    error: {
      code: "storage-delete-failed",
      message: "Impossible de supprimer le brouillon local.",
    },
  });

  assert.deepEqual(result, {
    ok: false,
    errorMessage: "Impossible de supprimer le brouillon local.",
  });
});
