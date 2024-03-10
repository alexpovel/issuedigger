import { Ai } from "@cloudflare/ai";
import { Env, IndexGitHubItemMessage } from "..";
import {
  VectorMetadata,
  average,
  embedObject,
  getVectorId,
  getVectorNamespace,
  isValidVectorMetadata,
} from "../vectors";

/** This Durable Object represents a single, unique issue (with all its comments).
 *
 * For example, github.com/owner/repo/issues/4 .
 */
export class Issue {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  /** Interact with a single, specific issue through this method.
   *
   * All requests against it will be serialized.
   */
  async fetch(request: Request): Promise<Response> {
    // https://developers.cloudflare.com/durable-objects/reference/in-memory-state/#stateblockconcurrencywhile-method
    // The idea behind `blockConcurrencyWhile` is to serialize working on a single
    // issue. The Durable Object is already *per issue*, so concurrent requests here
    // mean, for example, that two issue comments at the same time are submitted. We
    // don't want to lose data ("last writer wins"), so serialize them.
    await this.state.blockConcurrencyWhile(async () => {
      const msg = new IndexGitHubItemMessage(await request.json());

      const embedding = await embedObject(msg, new Ai(this.env.AI));

      const id = getVectorId(
        { name: msg.repository.name, owner: msg.repository.owner },
        msg.issue.number,
        1
      );
      console.debug("Will query for potentially existing vector ID", id);

      const vectors = await this.env.VECTORIZE_INDEX.getByIds([id]);

      let vector: VectorizeVector;
      if (vectors.length > 0) {
        // We only queried for one, so we only expect one.
        vector = vectors[0];

        console.info(`Vector for '${id}' already exists. Enriching it.`);
        vector.values = average([Array.from(vector.values), embedding]);

        await this.env.VECTORIZE_INDEX.upsert([vector]);
      } else {
        console.info(`Vector for '${id}' does not exist yet. Creating it.`);

        const metadata: VectorMetadata = {
          version: 1,
          issue: {
            number: msg.issue.number,
          },
          repository: msg.repository,
        };

        if (!isValidVectorMetadata(metadata, 1)) {
          throw Error(`Invalid vector metadata: ${JSON.stringify(metadata)}`);
        }

        vector = {
          id: id,
          namespace: getVectorNamespace({
            name: msg.repository.name,
            owner: msg.repository.owner,
          }),
          values: embedding,
          // ⚠️ This is a bit crap. My TypeScript-foo isn't good enough to make this
          // valid.
          metadata: metadata as unknown as Record<
            string,
            VectorizeVectorMetadata
          >,
        };

        // We *want* this to blow up on conflict w/ an existing ID (as `insert` does) to
        // catch errors (`upsert` would overwrite).
        await this.env.VECTORIZE_INDEX.insert([vector]);
      }

      console.debug(
        "Stored vector",
        vector.id,
        vector.namespace,
        JSON.stringify(vector.metadata)
      );

      try {
        // For bookkeeping of which vectors we have stored.
        await this.env.VECTORS.put(id, "");
      } catch (error) {
        console.error("KV insertion failed with error", JSON.stringify(error));
        throw error;
      }
    });

    return new Response("Stored vector", { status: 201 });
  }
}
