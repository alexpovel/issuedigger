# Architecture

## Working principle

The below sequence diagram shows a detailed (contains all implementation details) sample
software lifecycle, where:

1. a repository maintainer initially installs the application, triggering an initial
   backfill
2. a user later posts a new issue, triggering a comment from issuedigger
3. another user (in this example, the maintainer) comments in that same issue thread.
   The new comment will contribute to that issue's embedding
4. to see if new comments on an issue shifted similarities enough to bring forth new
   results, one can comment `@issuedigger dig`
5. the app can be uninstalled anytime (either by removing it from one's account
   entirely, or revoking access to specific repositores), triggering a wipe of all
   stored data. This is a destructive action, and later reinstallation (possible
   anytime) might not restore all data (due to aforementioned GitHub API request limits)

```mermaid
sequenceDiagram
  autonumber
  actor M as Maintainer
  actor U as User
  participant ID as issuedigger (GitHub App)
  participant GH as GitHub Repo
  participant CFW as Cloudflare Worker
  participant CFQ as Cloudflare Queue
  participant CFWAI as Cloudflare Workers AI
  participant CFV as Cloudflare Vectorize
  participant CFDO as Cloudflare Durable Object
  participant CFKV as Cloudflare KV
  M->>ID: Visit page and install
  ID->>GH: Is granted access to
  ID->>CFW: Installation webhook fires
  CFW->>CFQ: Submit work
  Note over CFQ, CFW: Same Worker is both<br/>producer and consumer.<br/>Every webhook goes through<br/>the Queue.<br/>(Only shown once for simplicity)
  CFQ->>CFW: Dispatch work
  CFW->>GH: Fetch past items
  Note over CFW, GH: via REST API
  GH->>CFW: Items
  loop Per item
    CFW->>CFDO: Acquire "lock" for issue
    Note over CFW, CFDO: Serializing work per issue<br/>avoids "last writer wins"
    CFW->>CFW: Split body into paragraphs
    loop Per paragraph
      CFW->>CFWAI: Generate embedding
      alt Happy path
        CFWAI->>CFW: Embedding
      else Paragraph too long
        CFW->>CFWAI: Generate summary
        CFWAI->>CFW: Summary
        CFW->>CFWAI: Generate embedding
        CFWAI->>CFW: Embedding
      end
    end
    CFW->>CFW: Compute mean of all paragraph vectors
    CFW->>CFV: Store vector under issue number
    CFW->>CFKV: Store vector ID (for bookkeeping only)
    alt Exists
      Note over CFW, CFV: For example, because item is comment
      CFW->>CFW: Average with existing
      CFW->>CFV: Store
    end
    CFW->>CFDO: Release issue lock
  end
  U->>GH: Opens new issue
  ID->>CFW: "New issue" webhook fires
  CFW->>CFWAI: Get embedding (see above for details)
  CFWAI->>CFW: Embedding
  CFW->>CFV: Query for similar embeddings
  CFV->>CFW: Similar embeddings
  CFW->>GH: Post comment<br/>about similar issues
  CFW->>CFV: Store current embedding (see above for details)
  M->>GH: Post comment
  Note over M, GH: For example, suggesting solution
  ID->>CFW: "New issue comment" webhook fires
  CFW->>CFW: Index and store, averaging w/ existing vector<br/>(see above for details)
  M->>M: I wonder if<br/>similarities changed now
  M->>GH: Post `@issuedigger dig`
  ID->>CFW: "New issue comment" webhook fires
  Note over CFW: Indexing and storing skipped<br/>for app commands
  CFW->>GH: Post comment<br/>about similar issues
  Note over M: Had enough of this nonsense
  M->>ID: Uninstall
  ID->>CFW: "Uninstall" webhook fires
  CFW->>CFKV: Query stored vector IDs for repo
  CFKV->>CFW: Vector IDs associated with repo
  loop Per ID
    CFW->>CFV: Delete
    CFW->>CFKV: Delete
  end
```

### Design Notes

- [Durable Objects](https://developers.cloudflare.com/durable-objects/) are used as
  mutexes, in an attempt to serialize work on individual issues.

  When two items of the *same issue thread* are processed concurrently (e.g. during
  backfilling, or if two comments are submitted simultaneously), we'd have
  last-writer-wins issues otherwise, losing data. Serialization by the introduction of a
  per-issue critical section alleviates this.
- [KV Storage](https://developers.cloudflare.com/kv/) is *only* needed for bookkeeping:
  when offboarding an installation, all related vectors need to be removed, but
  Vectorize can only be [queried by exact
  IDs](https://developers.cloudflare.com/vectorize/reference/client-api/#get-vectors-by-id).
  KV with its [prefix
  querying](https://developers.cloudflare.com/kv/api/list-keys/#list-method) helps
  retrieve those exact IDs after the fact.
- Generation of embeddings is pretty [grug-brained](https://grugbrain.dev/). Splitting
  into paragraphs before processing might lose important context. For example,

  ```text
  Her shoes are red.␊
  ␊
  They taste like strawberry.
  ```

  makes no sense if taken (embedded) as one unit. The resulting vector might be
  "semantically malformed". issuedigger instead embeds these separately, and averages
  the results. The resulting mean vector is likely quite different from the single
  embedding, leading to different results.

  Paragraphs are embedded separately chiefly due to **limitations in the [used
  model](https://developers.cloudflare.com/workers-ai/models/bge-large-en-v1.5/)**,
  which maxes out at 512 input tokens (whatever that means in characters 🤷‍♀️). If
  possible, embedding issue (comment) bodies in one go would be wildly preferable.

  If individual paragraphs are *still* overly long, a
  [summarization](https://developers.cloudflare.com/workers-ai/models/#summarization) is
  applied.

  The used models and how issuedigger handles overly long input is likely the bottleneck
  to its usefulness. Available models are lightweight, with very fast inference, at the
  cost of power in other areas, workarounds to which issuedigger implements in
  simplistic, potentially even wrong ways!
