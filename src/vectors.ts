import { Ai } from "@cloudflare/ai";
import { VectorizeVector as BaseVectorizeVector } from "@cloudflare/workers-types/2023-07-01";
import { embed } from "./ai";

/** Averages multiple vectors. */
export function average(vectors: number[][]) {
  // Grug brain move. But it works?! Instead of storing a single embedding/vector, we
  // could also store *many* (one per chunk), which would probably answer questions like
  // "was topic X mentioned anywhere?" better. An average vector feels more like "what
  // is the general vibe of this issue?".

  const nullVector = new Array<number>(vectors[0].length).fill(0);

  const averageVector = vectors
    .reduce((acc, vec) => acc.map((val, i) => val + vec[i]), nullVector)
    .map((val) => val / vectors.length);

  return averageVector;
}

export async function embedObject(
  { title, body }: { title?: string | null; body?: string | null },
  ai: Ai
) {
  return embed(`${title ?? ""}\n${body ?? ""}`, ai);
}

export function getVectorNamespace(repo: { owner: string; name: string }) {
  // Prefix with version for potential future evolution, for example when vector
  // metadata changes.
  const nsVersion = "1";

  const ns = `N${nsVersion}/${repo.owner}/${repo.name}` as VectorNamespace;

  if (new TextEncoder().encode(ns).length > 63) {
    // Don't explode here, just warn, as limits might change, and things *might* not
    // explode. https://developers.cloudflare.com/vectorize/platform/limits/. Could also
    // hash and base64-encode, but that kills readability etc.
    console.warn(
      `Namespace '${ns}' is longer than 63 bytes. This will probably cause issues.`
    );
  }

  return ns;
}

export async function query(
  vector: VectorizeVector,
  vector_index: VectorizeIndex,
  topK: number
) {
  const res = await vector_index.query(vector.values, {
    namespace: vector.namespace,
    topK: topK,
    returnMetadata: true,
  });
  console.info(
    `Queried in NS '${vector.namespace}', got ${res.matches.length} matches`
  );
  return res;
}

interface VectorMetadataV1 {
  version: 1;
  issue: {
    number: number;
  };
  repository: { owner: string; name: string };
}

/** For potential future evolution; can become union type. */
export type VectorMetadata = VectorMetadataV1;

export function isValidVectorMetadata(
  data: unknown,
  version: 1
): data is VectorMetadataV1;

/** Vector metadata storing and later loading isn't typesafe, as it's typed as a generic
 * `Record`. This function servers as *both* compile-time and runtime validation. Its
 * use signals all the places we handle vector metadata. As such, this function is the
 * central place for handling validation. Sadly, we cannot enforce its use on the type
 * level. */
export function isValidVectorMetadata(
  data: unknown,
  version: number
): data is VectorMetadata {
  switch (version) {
    case 1: {
      if (typeof data !== "object" || data === null) return false;

      const hasIssue =
        "issue" in data &&
        typeof (data as { issue: unknown }).issue === "object";
      const issueNumberValid =
        hasIssue &&
        typeof (data as { issue: { number: unknown } }).issue.number ===
          "number";

      const hasRepository =
        "repository" in data &&
        typeof (data as { repository: unknown }).repository === "object";
      const ownerValid =
        hasRepository &&
        typeof (data as { repository: { owner: unknown } }).repository.owner ===
          "string";
      const nameValid =
        hasRepository &&
        typeof (data as { repository: { name: unknown } }).repository.name ===
          "string";

      return issueNumberValid && ownerValid && nameValid;
    }
    default:
      return false;
  }
}

export function getBaseVectorId(
  repo: { owner: string; name: string },
  version: 1
) {
  // ⚠️ Assumption: vector IDs must be unique per *index*, not just per namespace.
  // This is a conservative assumption, and won't break anything if wrong.

  // Prefix with version for potential future evolution, for example when vector
  // metadata changes.
  let id = `I${version}/${repo.owner}/${repo.name}`;

  // ⚠️ https://developers.cloudflare.com/kv/api/write-key-value-pairs/#parameters. The
  // vector ID might need to be stored in KV (the fact that this function "knows" that
  // is bad separation...). In KV, periods are illegal. GitHub usernames only contain
  // alphanumeric characters and dashes. Repo names may not contain `@`. So use that as
  // a unique equivalent. Shouldn't conflict with anything.
  id = id.replaceAll(".", "@");

  return id;
}

export function getVectorId(
  repo: { owner: string; name: string },
  issueNumber: number,
  version: 1
) {
  const baseId = getBaseVectorId(repo, version);
  const id = `${baseId}/${issueNumber}`;

  if (new TextEncoder().encode(id).length > 64) {
    // Don't explode here, just warn, as limits might change, and things *might* not
    // explode. https://developers.cloudflare.com/vectorize/platform/limits/
    console.warn(
      `Vector ID '${id}' is longer than 64 bytes. This will probably cause issues.`
    );
  }

  return id as VectorId;
}

/** Makes the base interface more type-safe. */
export interface VectorizeVector extends BaseVectorizeVector {
  /** Namespace of the vector. Making this required helps ensure all vectors are
   * properly segregated on the type level. */
  namespace: VectorNamespace;
  id: VectorId;
}

// Some newtype-like type safety...
export type VectorNamespace = string & { readonly __tag: unique symbol };
export type VectorId = string & { readonly __tag: unique symbol };
