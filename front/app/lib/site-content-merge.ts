import { siteContentSchema } from "@eszter/contracts";
import type { SiteContent } from "../types/site-content";

/**
 * Deterministic three-way reconciliation of a `SiteContent` document (ESZ-034).
 *
 * The editor holds three copies of the document whenever a save is refused with
 * `409 REVISION_CONFLICT`: the **base**, which is the content of the revision it
 * originally loaded; the **local** copy, which is what the admin has been
 * typing into; and the **server** copy, which is whatever the draft head holds
 * now. A conflict is only genuinely a conflict where those three disagree in the
 * same place.
 *
 * ## Why this exists rather than a rebase
 *
 * The previous recovery path let the editor adopt the head reported in the 409
 * and save again. That is a force-overwrite wearing a confirmation dialog: the
 * content of the revision being adopted was never read, so anything the other
 * editor wrote between the two saves was destroyed without either person seeing
 * it. Optimistic concurrency was doing its job — the 409 is the safety barrier —
 * and the browser was stepping around it.
 *
 * So the reconciliation here reads the other revision's *content* and decides
 * per field. Where only one side moved, the answer is that side's value and no
 * information is lost. Where both moved to different values, there is no
 * defensible automatic answer, and the merge refuses rather than picking one.
 *
 * ## Determinism, and what "conservative" means for arrays
 *
 * Nothing in this module is time-, order- or heuristic-dependent: the same three
 * documents always produce the same result. Arrays are where a merge is most
 * tempted to guess, so they get the strictest rule. `SiteContent` arrays are
 * fixed-length and id-pinned by the contract, which means a length change or a
 * reordering is *never* an ordinary edit — it is either a structural change or a
 * corrupted document. Either way, merging it element-by-element would silently
 * pair up elements that are not the same element. Such an array is reported as a
 * conflict and left to a human.
 */

/** A place where base, local and server disagree irreconcilably. */
export interface SiteContentMergeConflict {
  /** Segments from the document root, e.g. `["services", "items", "1", "title"]`. */
  path: string[];
  kind:
    /** Both sides set the same field to different values. */
    | "value"
    /** The two sides disagree about the shape (object vs array vs scalar). */
    | "type"
    /** An array changed length, was reordered, or lost its id alignment. */
    | "array-shape"
    /** The merged document did not validate as `SiteContent`. */
    | "invalid-result";
  base: unknown;
  local: unknown;
  server: unknown;
}

export type SiteContentMergeResult =
  | {
      ok: true;
      merged: SiteContent;
      /** Whether the merge kept anything the server copy did not already have. */
      changedFromServer: boolean;
    }
  | { ok: false; conflicts: SiteContentMergeConflict[] };

/** Marks a key that is absent from one of the three documents. */
const ABSENT = Symbol("absent");
type Slot = unknown | typeof ABSENT;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Structural equality that does not depend on key order.
 *
 * A `JSON.stringify` comparison would report two documents as different because
 * one of them came back from PHP with its keys in schema order — which is
 * exactly what happens on the path this module runs on, and would turn every
 * reconciliation into a conflict.
 */
function deepEqual(first: Slot, second: Slot): boolean {
  if (first === ABSENT || second === ABSENT) return first === second;
  if (first === second) return true;

  if (Array.isArray(first) || Array.isArray(second)) {
    if (!Array.isArray(first) || !Array.isArray(second)) return false;
    if (first.length !== second.length) return false;
    return first.every((item, index) => deepEqual(item, second[index]));
  }

  if (isPlainObject(first) && isPlainObject(second)) {
    const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
    for (const key of keys) {
      const left: Slot = key in first ? first[key] : ABSENT;
      const right: Slot = key in second ? second[key] : ABSENT;
      if (!deepEqual(left, right)) return false;
    }
    return true;
  }

  // NaN never appears in a validated `SiteContent`, so `===` above is the whole
  // scalar rule and there is no special case to get wrong here.
  return false;
}

/** A stable, order-independent fingerprint, used only to detect reorderings. */
function fingerprint(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(fingerprint).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${fingerprint(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The id sequence of an array, or `null` when its elements are not id-bearing.
 *
 * Every collection the contract pins — navigation links, services, process
 * steps, gallery items, footer links — carries an `id` per element, and that id
 * is the only thing that says two elements from two documents are the same
 * element. Positional identity is not a substitute: it is what makes a reorder
 * look like a simultaneous edit of every element.
 */
function identitySequence(items: unknown[]): string[] | null {
  const ids: string[] = [];

  for (const item of items) {
    if (!isPlainObject(item)) return null;
    const id = item["id"];
    if (typeof id !== "string") return null;
    ids.push(id);
  }

  return ids;
}

function sequenceEqual(first: readonly string[], second: readonly string[]): boolean {
  return (
    first.length === second.length && first.every((value, index) => value === second[index])
  );
}

/** Whether `candidate` is `reference` with the same elements in another order. */
function isReordering(reference: unknown[], candidate: unknown[]): boolean {
  if (reference.length !== candidate.length) return false;

  const referencePrints = reference.map(fingerprint);
  const candidatePrints = candidate.map(fingerprint);
  if (sequenceEqual(referencePrints, candidatePrints)) return false;

  const sortedReference = [...referencePrints].sort();
  const sortedCandidate = [...candidatePrints].sort();
  return sequenceEqual(sortedReference, sortedCandidate);
}

class MergeCollector {
  readonly conflicts: SiteContentMergeConflict[] = [];

  record(
    path: string[],
    kind: SiteContentMergeConflict["kind"],
    base: Slot,
    local: Slot,
    server: Slot,
  ): void {
    this.conflicts.push({
      path: [...path],
      kind,
      base: base === ABSENT ? undefined : base,
      local: local === ABSENT ? undefined : local,
      server: server === ABSENT ? undefined : server,
    });
  }
}

function mergeValue(
  base: Slot,
  local: Slot,
  server: Slot,
  path: string[],
  collector: MergeCollector,
): Slot {
  // The three cheap answers, in the order that makes the expensive one rare.
  // Both sides landing on the same value is agreement, not a conflict, even when
  // they got there independently.
  if (deepEqual(local, server)) return server;
  // Only the server moved: the admin never touched this field, so taking the
  // server's value loses nothing of theirs.
  if (deepEqual(base, local)) return server;
  // Only the admin moved: the other editor never touched it.
  if (deepEqual(base, server)) return local;

  if (isPlainObject(base) && isPlainObject(local) && isPlainObject(server)) {
    const keys = [
      ...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(server)]),
    ];
    const merged: Record<string, unknown> = {};

    for (const key of keys) {
      const result = mergeValue(
        key in base ? base[key] : ABSENT,
        key in local ? local[key] : ABSENT,
        key in server ? server[key] : ABSENT,
        [...path, key],
        collector,
      );
      if (result !== ABSENT) merged[key] = result;
    }

    return merged;
  }

  if (Array.isArray(base) && Array.isArray(local) && Array.isArray(server)) {
    return mergeArray(base, local, server, path, collector);
  }

  // One side replaced an object with a scalar, or a key appeared on both sides
  // with different values. Neither has a defensible automatic answer.
  const bothStructural =
    (isPlainObject(local) || Array.isArray(local)) &&
    (isPlainObject(server) || Array.isArray(server));
  collector.record(path, bothStructural ? "type" : "value", base, local, server);
  return server;
}

/**
 * Merges two edits of the same array, or refuses.
 *
 * The refusal cases are the point. A length change means an element was added or
 * removed, and there is no way to tell which of the remaining elements the other
 * side's edits belong to. A reordering means positional alignment is a lie. An
 * id sequence that stopped matching means the same, and says so earlier and more
 * precisely. In all three the merge stops; guessing here is how a merge quietly
 * moves an admin's paragraph onto the wrong service.
 */
function mergeArray(
  base: unknown[],
  local: unknown[],
  server: unknown[],
  path: string[],
  collector: MergeCollector,
): unknown[] {
  if (local.length !== base.length || server.length !== base.length) {
    collector.record(path, "array-shape", base, local, server);
    return server;
  }

  const baseIds = identitySequence(base);
  if (baseIds !== null) {
    const localIds = identitySequence(local);
    const serverIds = identitySequence(server);

    if (
      localIds === null ||
      serverIds === null ||
      !sequenceEqual(baseIds, localIds) ||
      !sequenceEqual(baseIds, serverIds)
    ) {
      collector.record(path, "array-shape", base, local, server);
      return server;
    }
  } else if (isReordering(base, local) || isReordering(base, server)) {
    // Id-less arrays — `about.paragraphs` — cannot be aligned any other way, so
    // a permutation is treated as a structural change rather than as three
    // simultaneous edits that happen to be each other's old values.
    collector.record(path, "array-shape", base, local, server);
    return server;
  }

  return base.map((element, index) =>
    mergeValue(element, local[index], server[index], [...path, String(index)], collector),
  );
}

/**
 * Reconciles `local` and `server`, both descended from `base`.
 *
 * The result is validated before it is returned. A merge is a document nothing
 * has ever validated — each field came from a document that was valid, which
 * says nothing about the combination — and the one thing worse than refusing a
 * merge is saving a `SiteContent` that no longer satisfies its own schema.
 */
export function mergeSiteContent(
  base: SiteContent,
  local: SiteContent,
  server: SiteContent,
): SiteContentMergeResult {
  const collector = new MergeCollector();
  const merged = mergeValue(base, local, server, [], collector);

  if (collector.conflicts.length > 0) {
    return { ok: false, conflicts: collector.conflicts };
  }

  const parsed = siteContentSchema.safeParse(merged);

  if (!parsed.success) {
    return {
      ok: false,
      conflicts: [
        { path: [], kind: "invalid-result", base, local, server },
      ],
    };
  }

  return {
    ok: true,
    merged: parsed.data as SiteContent,
    changedFromServer: !deepEqual(parsed.data, server),
  };
}

/** French section names, so a conflict reads as a place rather than as a path. */
const CONFLICT_SECTION_LABELS: Record<string, string> = {
  appearance: "Apparence",
  navigation: "Navigation",
  hero: "Bandeau d’accueil",
  reassurance: "Réassurance",
  services: "Prestations",
  process: "Parcours",
  gallery: "Réalisations",
  about: "À propos",
  contact: "Contact",
  footer: "Pied de page",
};

/** One human-readable line per conflict, for the reconciliation panel. */
export function describeMergeConflict(conflict: SiteContentMergeConflict): string {
  if (conflict.kind === "invalid-result") {
    return "La fusion produirait un contenu que le contrat refuse. Aucune écriture n’a été tentée.";
  }

  const [section, ...rest] = conflict.path;
  const label = section ? (CONFLICT_SECTION_LABELS[section] ?? section) : "Document";
  const where = rest.length > 0 ? `${label} → ${rest.join(" → ")}` : label;

  if (conflict.kind === "array-shape") {
    return `${where} : la liste a changé de structure des deux côtés (ordre, ajout ou suppression).`;
  }
  if (conflict.kind === "type") {
    return `${where} : les deux versions ont une structure différente.`;
  }

  return `${where} : modifié des deux côtés avec des valeurs différentes.`;
}
