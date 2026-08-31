import assert from "node:assert/strict";
import test from "node:test";
import { defaultSiteContent } from "@eszter/contracts";
import type { SiteContent } from "../app/types/site-content";
import {
  describeMergeConflict,
  mergeSiteContent,
} from "../app/lib/site-content-merge";

/**
 * ESZ-034 — the three-way reconciliation that replaced the blind rebase.
 *
 * Two properties are being pinned here, and they pull in opposite directions on
 * purpose. Work must not be lost where the two editors touched different things:
 * refusing every concurrent edit would push admins straight back to copying text
 * out by hand, which is the behaviour the old rebase button existed to avoid.
 * And nothing may be decided where they touched the same thing: a merge that
 * guesses is a slower, better-hidden version of the overwrite this corrects.
 */

function edit(mutate: (content: SiteContent) => void): SiteContent {
  const content = structuredClone(defaultSiteContent) as SiteContent;
  mutate(content);
  return content;
}

const base = structuredClone(defaultSiteContent) as SiteContent;

test("two tabs editing different sections both keep their work", () => {
  const local = edit((content) => {
    content.hero.title.emphasized = "Un regard";
  });
  const server = edit((content) => {
    content.contact.title = "Écrivez-moi";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.merged.hero.title.emphasized, "Un regard");
  assert.equal(result.merged.contact.title, "Écrivez-moi");
  // The merge carries something the server does not have, so it is worth a save.
  assert.equal(result.changedFromServer, true);
});

test("two tabs editing different fields of the same item both keep their work", () => {
  const local = edit((content) => {
    content.services.items[0]!.title = "Sourcils sur mesure";
  });
  const server = edit((content) => {
    content.services.items[0]!.description = "Une teinte plus douce.";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.merged.services.items[0]!.title, "Sourcils sur mesure");
  assert.equal(
    result.merged.services.items[0]!.description,
    "Une teinte plus douce.",
  );
});

test("the same field changed on both sides is refused, never picked", () => {
  const local = edit((content) => {
    content.hero.title.emphasized = "Version locale";
  });
  const server = edit((content) => {
    content.hero.title.emphasized = "Version serveur";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0]!.path, ["hero", "title", "emphasized"]);
  assert.equal(result.conflicts[0]!.kind, "value");
  assert.equal(result.conflicts[0]!.local, "Version locale");
  assert.equal(result.conflicts[0]!.server, "Version serveur");
});

test("both sides making the identical edit is agreement, not a conflict", () => {
  const local = edit((content) => {
    content.contact.title = "Prendre rendez-vous";
  });
  const server = edit((content) => {
    content.contact.title = "Prendre rendez-vous";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.merged.contact.title, "Prendre rendez-vous");
  // Nothing to write: the server already holds this exact document.
  assert.equal(result.changedFromServer, false);
});

test("a reordered list is a structural change, never merged element by element", () => {
  const local = edit((content) => {
    const links = content.navigation.links;
    [links[0], links[1]] = [links[1]!, links[0]!];
  });
  const server = edit((content) => {
    content.navigation.links[0]!.label = "Prestations et tarifs";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, false);
  if (result.ok) return;
  // Positional merging here would move the server's new label onto whichever
  // link the reorder happened to put first — a silent, plausible-looking
  // corruption rather than a visible refusal.
  assert.deepEqual(result.conflicts[0]!.path, ["navigation", "links"]);
  assert.equal(result.conflicts[0]!.kind, "array-shape");
});

test("a reordered id-less list is refused too", () => {
  const local = edit((content) => {
    const paragraphs = content.about.paragraphs;
    [paragraphs[0], paragraphs[2]] = [paragraphs[2]!, paragraphs[0]!];
  });
  const server = edit((content) => {
    content.about.paragraphs[1] = "Un autre paragraphe.";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, false);
  if (result.ok) return;
  // `about.paragraphs` carries no ids, so a permutation cannot be told from
  // three simultaneous edits by looking at values. It is treated as structural.
  assert.deepEqual(result.conflicts[0]!.path, ["about", "paragraphs"]);
  assert.equal(result.conflicts[0]!.kind, "array-shape");
});

test("a list that changed length on one side is refused", () => {
  const local = edit((content) => {
    content.gallery.items.pop();
  });
  const server = edit((content) => {
    content.gallery.items[0]!.caption = "Sourcils naturels, cicatrisés";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(result.conflicts[0]!.path, ["gallery", "items"]);
  assert.equal(result.conflicts[0]!.kind, "array-shape");
});

test("different elements of the same aligned list merge", () => {
  const local = edit((content) => {
    content.process.steps[0]!.title = "Échange initial";
  });
  const server = edit((content) => {
    content.process.steps[3]!.description = "Une retouche à six semaines.";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.merged.process.steps[0]!.title, "Échange initial");
  assert.equal(
    result.merged.process.steps[3]!.description,
    "Une retouche à six semaines.",
  );
});

test("the merged document is validated before it is ever offered for a save", () => {
  const local = edit((content) => {
    // A URL the contract refuses. It cannot arrive from a validated envelope, so
    // this stands in for any future field pair whose *combination* is invalid.
    (content.contact.emailCta as { href: string }).href = "pas-un-mailto";
  });
  const server = edit((content) => {
    content.hero.title.emphasized = "Autre chose";
  });

  const result = mergeSiteContent(base, local, server);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.conflicts[0]!.kind, "invalid-result");
  assert.match(describeMergeConflict(result.conflicts[0]!), /contrat refuse/i);
});

test("key order coming back from PHP is not a difference", () => {
  // The same document with its top-level keys emitted in the reverse order, the
  // way a re-serialisation on the PHP side can legitimately hand it back.
  const reordered = Object.fromEntries(
    Object.entries(base).reverse(),
  ) as unknown as SiteContent;
  const local = edit((content) => {
    content.footer.copyrightName = "Eszter";
  });

  const result = mergeSiteContent(base, local, reordered);

  // A `JSON.stringify` comparison would call every field different here and turn
  // an ordinary save into a wall of conflicts.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.merged.footer.copyrightName, "Eszter");
});

test("a conflict reads as a place in the document, in French", () => {
  const line = describeMergeConflict({
    path: ["services", "items", "1", "title"],
    kind: "value",
    base: "a",
    local: "b",
    server: "c",
  });

  assert.match(line, /Prestations/);
  assert.match(line, /items → 1 → title/);
});
