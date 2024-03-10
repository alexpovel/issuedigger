import { Ai } from "@cloudflare/ai";
import type { EventPayloadMap, WebhookEvent } from "@octokit/webhooks-types";
import type { AppSecret, Pkcs8PemPrivateKey, ValidationToken } from "./github";
import {
  WebhookValidationError,
  getOctokit,
  tryValidateWebhookSignature,
} from "./github";
import {
  VectorizeVector,
  embedObject,
  getBaseVectorId,
  getVectorId,
  getVectorNamespace,
  isValidVectorMetadata,
  query,
} from "./vectors";

// Hi and welcome to hell! Apologies in advance for what could be the worst TypeScript
// you've ever seen. The code is best understood as a "weekend hacking project", and
// ranks as some of the most rancid I've ever been guilty of producing.

export interface Env {
  // Cloudflare-injected
  AI: Ai;
  VECTORIZE_INDEX: VectorizeIndex;
  GENERAL_PURPOSE: Queue<QueueMessage>;
  ISSUE: DurableObjectNamespace;
  // For bookkeeping only. Currently, Vectorize doesn't support deleting everything in a
  // namespace, for example. It only supports deleting specific IDs. As such, we need to
  // keep track of IDs in the index somewhere else, so we can later enumerate them.
  VECTORS: KVNamespace;

  // Environment-injected (locally, via `.dev.vars` (for secrets) and `wrangler.toml`
  // (see `vars`))
  GITHUB_APP_SLUG: string;
  GITHUB_APP_ID: string;
  // https://docs.github.com/en/enterprise-cloud@latest/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation#using-the-octokitjs-sdk-to-authenticate-as-an-app-installation:
  GITHUB_APP_PRIVATE_KEY: Pkcs8PemPrivateKey;
  // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries:
  GITHUB_APP_WEBHOOK_SECRET: AppSecret;
  GITHUB_ONBOARDING_LOOKBACK_LIMIT: string;
  N_SIMILAR_ISSUES: string;
  GITHUB_APP_OWNER: string;
}

interface IQueueMessage {
  type:
    | "index_issue"
    | "index_issue_comment"
    | "reindex_issue_comments"
    | "onboard"
    | "offboard"
    | "post_comment";
}

/**
 * This will be sent across the queue for downstream consumption.
 *
 * Maximum message size is 128 KB
 * (https://developers.cloudflare.com/queues/platform/limits/), and we are blindly
 * sending the entire issue (comment) body here. That *should* be fine most of the time,
 * as that is limited to 65,536 characters
 * (https://github.com/orgs/community/discussions/27190#discussioncomment-3254953).
 * Assuming most of these are ASCII, it works. For multi-byte UTF-8, queue submission
 * will eventually fail (not sure how failure would surface in our code).
 *
 * Make this a class to strip extra properties from the JSON representation.
 */
export class IndexGitHubItemMessage implements IQueueMessage {
  type: "index_issue" | "index_issue_comment";
  issue: {
    number: number;
  };
  title: string | undefined;
  body: string | null | undefined;
  repository: {
    owner: string;
    name: string;
  };
  isOurselves: boolean;
  installationId: number;

  constructor({
    type,
    issue,
    title,
    body,
    repository,
    isOurselves,
    installationId,
  }: {
    type: "index_issue" | "index_issue_comment";
    installationId: number;
    issue: { number: number };
    title: string | undefined;
    body: string | null | undefined;
    repository: { owner: string; name: string };
    isOurselves: boolean;
  }) {
    this.type = type;
    this.issue = issue;
    this.title = title;
    this.body = body;
    this.repository = repository;
    this.isOurselves = isOurselves;
    this.installationId = installationId;
  }
}

class ReindexCommentsMessage implements IQueueMessage {
  type: "reindex_issue_comments";
  issue: {
    number: number;
  };
  repository: {
    owner: string;
    name: string;
  };
  installationId: number;

  constructor({
    installationId,
    issue,
    repository,
  }: {
    installationId: number;
    issue: { number: number };
    repository: { owner: string; name: string };
  }) {
    this.type = "reindex_issue_comments";
    this.installationId = installationId;
    this.issue = issue;
    this.repository = repository;
  }
}

class RepoOnboardingMessage implements IQueueMessage {
  type: "onboard";
  /** We will need authentication against GitHub on the queue consumer. The app
   * installation ID is not statically known, so send it alongside. */
  installationId: number;
  repository: {
    owner: string;
    name: string;
  };

  constructor({
    installationId,
    repository,
  }: {
    installationId: number;
    repository: { owner: string; name: string };
  }) {
    this.type = "onboard";
    this.installationId = installationId;
    this.repository = repository;
  }
}

class RepoOffboardingMessage implements IQueueMessage {
  type: "offboard";
  repository: {
    owner: string;
    name: string;
  };

  constructor({ repository }: { repository: { owner: string; name: string } }) {
    this.type = "offboard";
    this.repository = repository;
  }
}

class PostCommentMessage implements IQueueMessage {
  type: "post_comment";
  installationId: number;
  repository: {
    owner: string;
    name: string;
  };
  issue: {
    number: number;
    title: string | undefined;
    body: string | undefined | null;
  };

  constructor({
    installationId,
    repository,
    issue,
  }: {
    installationId: number;
    repository: { owner: string; name: string };
    issue: {
      number: number;
      title: string | undefined;
      body: string | undefined | null;
    };
  }) {
    this.type = "post_comment";
    this.installationId = installationId;
    this.repository = repository;
    this.issue = issue;
  }
}

type QueueMessage =
  | IndexGitHubItemMessage
  | ReindexCommentsMessage
  | RepoOnboardingMessage
  | RepoOffboardingMessage
  | PostCommentMessage;

/**
 * Maps a GitHub-sent event type to a type-safe payload. This function helps with type
 * narrowing. At runtime, it is safe if the GitHub API doesn't misbehave.
 *
 * The possible events are listed in
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers .
 */
function isEvent<K extends keyof EventPayloadMap>(
  event: WebhookEvent,
  name: K,
  eventNameFromHeader: string
): event is EventPayloadMap[K] {
  return eventNameFromHeader === name;
}

async function route(request: Request, env: Env) {
  const path = new URL(request.url).pathname;

  switch (path) {
    case "/": {
      return Response.redirect("https://github.com/alexpovel/issuedigger", 301);
    }
    case "/webhook": {
      console.info("Webhook received");

      if (request.method !== "POST") {
        console.warn("Method not allowed", request.method);
        return new Response("Method not allowed", { status: 405 });
      }

      const ghSig = request.headers.get("x-hub-signature-256");

      if (ghSig === null) {
        console.warn("No signature in headers. GitHub changed?");
        return new Response("Can only process signed requests", {
          status: 400,
        });
      }

      // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#testing-the-webhook-payload-validation
      // Hard-coding this here is a certified grug brain move.
      const sampleGhSig =
        "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";
      if (ghSig.length !== sampleGhSig.length) {
        // Might be overkill. Just in case the header value is unreasonable, don't even
        // process it.
        console.warn("Signature length unexpected", ghSig);
        return new Response("Signature length unexpected", { status: 400 });
      }

      const body = await request.text();

      let proof; // Will remain undefined if signature verification fails
      try {
        proof = tryValidateWebhookSignature(
          body,
          env.GITHUB_APP_WEBHOOK_SECRET,
          ghSig
        );
      } catch (e) {
        if (!(e instanceof WebhookValidationError)) {
          throw e;
        }

        console.warn(
          `Signature verification failed: got '${e.signature.got}', expected '${e.signature.expected}'`
        );

        return new Response("Signature (GitHub App secret) mismatch", {
          status: 401,
        });
      }

      console.info("Signature verified");

      // https://docs.github.com/en/webhooks/webhook-events-and-payloads#delivery-headers
      const eventName = request.headers.get("x-github-event");

      if (eventName === null) {
        const msg = "No event name in headers. GitHub changed?";
        console.error(msg, JSON.stringify(request.headers));
        return new Response(msg, { status: 500 });
      }

      const event = (await JSON.parse(body)) as WebhookEvent;
      return await handleWebhookEvent(event, eventName, env, proof);
    }
    default:
      return new Response("Not found", { status: 404 });
  }
}

/** GitHub Apps have an attention span of 10 seconds, so it's important to
 * asynchronously delegate work to background processing, and reply within the given
 * time. Failing to return a response within the limit will *cancel* the worker
 * (https://developers.cloudflare.com/workers/platform/limits/#duration, "When the
 * client disconnects, all tasks associated with that client request are canceled").
 *
 * See also
 * https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/troubleshooting-webhooks#timed-out
 * */
async function handleWebhookEvent(
  event: WebhookEvent,
  eventName: string,
  env: Env,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _: ValidationToken
) {
  console.info("Webhook event received:", JSON.stringify(event));

  const isIssueEvent =
    isEvent(event, "issues", eventName) &&
    (event.action === "opened" || event.action === "edited");
  const isCommentEvent =
    isEvent(event, "issue_comment", eventName) &&
    (event.action === "created" || event.action === "edited");

  const isAppCommand = (body: string) => {
    return (
      isCommentEvent && body.trimStart().startsWith(`@${env.GITHUB_APP_SLUG} `)
    );
  };
  const eventIsAppCommand = isCommentEvent && isAppCommand(event.comment.body);

  const isInstallEvent =
    (isEvent(event, "installation_repositories", eventName) &&
      event.action === "added") ||
    (isEvent(event, "installation", eventName) && event.action === "created");
  const isUninstallEvent =
    (isEvent(event, "installation_repositories", eventName) &&
      event.action === "removed") ||
    (isEvent(event, "installation", eventName) && event.action === "deleted");

  // These give us the necessary type narrowing to work with the event payload.
  if (!(isIssueEvent || isCommentEvent || isInstallEvent || isUninstallEvent)) {
    const msg = "Event not relevant, skipping";
    console.info(msg);
    return new Response(msg, { status: 204 });
  }

  if (event.installation === undefined) {
    const msg = "GitHub App Installation ID missing, cannot authenticate";
    console.error(msg);
    return new Response(msg, { status: 400 });
  }

  const installationId = event.installation.id;
  console.debug("App has installation ID", installationId);

  const shouldPostComment =
    isIssueEvent || (eventIsAppCommand && event.comment.body.endsWith("dig"));

  if (shouldPostComment) {
    console.info("Triggered event for posting comment");

    await submit(
      new PostCommentMessage({
        installationId: installationId,
        repository: {
          owner: event.repository.owner.login,
          name: event.repository.name,
        },
        issue: event.issue,
      }),
      env.GENERAL_PURPOSE,
      isAppCommand
    );
  }

  const shouldOnboard =
    isInstallEvent ||
    (eventIsAppCommand &&
      event.comment.body.endsWith("onboard") &&
      // Only allow onboarding from the app owner, as this is an expensive operation
      // that if spammed, could be expensive.
      event.comment.user.login === env.GITHUB_APP_OWNER);

  if (shouldOnboard) {
    let repos;
    if (isEvent(event, "installation_repositories", eventName)) {
      console.info("Repositories added to existing app installation");
      repos = event.repositories_added;
    } else if (isEvent(event, "installation", eventName)) {
      console.info("Initial app installation");
      repos = event.repositories;
    } else {
      console.info("Onboarding requested via comment");
      repos = [event.repository];
    }

    console.info("Starting backfill of repositories");

    if (repos) {
      for (const repo of repos) {
        // Doesn't have this field sadly.
        const owner = repo.full_name.split("/")[0]; // 🤔

        await submit(
          new RepoOnboardingMessage({
            installationId: installationId,
            repository: { owner: owner, name: repo.name },
          }),
          env.GENERAL_PURPOSE,
          isAppCommand
        );
      }
    } else {
      console.warn("No repositories to onboard");
    }

    console.info("Onboarding submitted");
  }

  const shouldOffboard =
    isUninstallEvent ||
    (eventIsAppCommand &&
      event.comment.body.endsWith("offboard") &&
      // Only allow destructive action from the app owner.
      event.comment.user.login === env.GITHUB_APP_OWNER);

  if (shouldOffboard) {
    console.info("Will offboard");

    let repos;
    if (isEvent(event, "installation_repositories", eventName)) {
      console.debug("Repositories removed from existing application");
      repos = event.repositories_removed;
    } else if (isEvent(event, "installation", eventName)) {
      console.debug("App removed from entire account");
      repos = event.repositories;
    } else {
      console.debug("Offboarding request via comment");
      repos = [event.repository];
    }

    if (repos) {
      for (const repo of repos) {
        const owner = repo.full_name.split("/")[0]; // 🤔

        await submit(
          new RepoOffboardingMessage({
            repository: { owner: owner, name: repo.name },
          }),
          env.GENERAL_PURPOSE,
          isAppCommand
        );
      }
    }
  }

  const shouldIndexIndividualItem = isIssueEvent || isCommentEvent;
  const shouldReIndexEntireIssue =
    eventIsAppCommand &&
    event.comment.body.endsWith("reindex") &&
    // Potentially expensive operation, so restrict to app owner.
    event.comment.user.login === env.GITHUB_APP_OWNER;

  if (shouldIndexIndividualItem && !shouldReIndexEntireIssue) {
    console.info("Will submit to be indexed");

    let msg: IndexGitHubItemMessage;

    const common = {
      issue: {
        number: event.issue.number,
        html_url: event.issue.html_url,
      },
      repository: {
        owner: event.repository.owner.login,
        name: event.repository.name,
      },
      installationId: installationId,
    };

    if (isIssueEvent) {
      msg = {
        ...common,
        type: "index_issue",
        title: event.issue.title,
        body: event.issue.body,
        isOurselves:
          event.issue.performed_via_github_app?.id ===
          Number(env.GITHUB_APP_ID),
      };
    } else {
      msg = {
        ...common,
        type: "index_issue_comment",
        title: undefined,
        body: event.comment.body,
        isOurselves:
          event.comment.performed_via_github_app?.id ===
          Number(env.GITHUB_APP_ID),
      };
    }

    await submit(
      new IndexGitHubItemMessage({ ...msg }),
      env.GENERAL_PURPOSE,
      isAppCommand
    );
  } else if (shouldReIndexEntireIssue) {
    console.info("Will submit entire issue thread for reindexing");

    const repository = {
      owner: event.repository.owner.login,
      name: event.repository.name,
    };

    // The issue itself. We already have all info, so this is instant w/o I/O.
    await submit(
      new IndexGitHubItemMessage({
        type: "index_issue",
        installationId: installationId,
        issue: { ...event.issue },
        repository,
        title: event.issue.title,
        body: event.issue.body,
        isOurselves:
          event.issue.performed_via_github_app?.id ===
          Number(env.GITHUB_APP_ID),
      }),
      env.GENERAL_PURPOSE,
      isAppCommand
    );

    await submit(
      new ReindexCommentsMessage({
        installationId: installationId,
        issue: { number: event.issue.number },
        repository,
      }),
      env.GENERAL_PURPOSE,
      isAppCommand
    );

    console.info("Entire issue thread submitted for reindexing");
  }

  const shouldReactToComment = eventIsAppCommand;
  if (shouldReactToComment) {
    console.info("Will react to comment");

    const octokit = getOctokit(
      Number(env.GITHUB_APP_ID),
      env.GITHUB_APP_PRIVATE_KEY,
      installationId
    );

    await octokit.postReactionToComment(
      event.comment.id,
      { owner: event.repository.owner.login, name: event.repository.name },
      "+1"
    );
  }

  return new Response("Event processed", { status: 201 });
}

async function submit<M extends QueueMessage = QueueMessage>(
  msg: M,
  queue: Queue<M>,
  isAppCommand: (body: string) => boolean
) {
  console.debug("Submitting message to queue", JSON.stringify(msg));

  try {
    if (msg instanceof IndexGitHubItemMessage) {
      if (msg.isOurselves || (msg.body && isAppCommand(msg.body))) {
        console.info(
          "Not submitting, item is associated with this app",
          JSON.stringify(msg)
        );

        return;
      }

      console.debug("Submitting message for indexing", JSON.stringify(msg));
      await queue.send(msg);
    } else if (
      msg instanceof RepoOnboardingMessage ||
      msg instanceof RepoOffboardingMessage ||
      msg instanceof PostCommentMessage ||
      msg instanceof ReindexCommentsMessage
    ) {
      await queue.send(msg);
    } else {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const exhaustivenessCheck: never = msg;

      throw Error("Unknown message type"); // 😭
    }
  } catch (e) {
    console.error("Error submitting message for processing:", e);
  }
}

function formatResponse(matches: VectorizeMatch[]) {
  console.debug("Formatting response for vector matches");
  const n = matches.length;
  if (n === 0) {
    return "No similar issues found.";
  }

  // API returns these sorted already, but be sure in case behavior changes
  matches.sort((a, b) => a.score - b.score).reverse();

  const response_parts = ["The most similar issues to this one are:\n"];

  let i = 1;
  for (const match of matches) {
    const s = match.score;

    if (isValidVectorMetadata(match.metadata, 1)) {
      const issue_number = match.metadata.issue.number;
      response_parts.push(
        `${i}. #${issue_number} , with a similarity score of _${s.toPrecision(
          2
        )}_.`
      );
    } else {
      const msg = `Database metadata on vector ${
        match.id
      } isn't in usable format, got ${JSON.stringify(match.metadata)}`;
      console.error(msg);

      throw Error(msg);
    }

    if (s < 0.6) {
      response_parts[response_parts.length - 1] +=
        " ⚠️ This is a low score, indicating weak similarity.";
    }

    i++;
  }

  const response = response_parts.join("\n");
  console.info("Formatted response", JSON.stringify(response));
  return response;
}
// Need to re-export from entrypoint.
export { Issue } from "./persistence/do";

export default {
  /** Main Worker entrypoint. */
  async fetch(request: Request, env: Env) {
    console.info("Request received", JSON.stringify(request));
    return await route(request, env);
  },

  /** https://developers.cloudflare.com/queues/reference/how-queues-works/#consumers */
  // eslint-disable-next-line @typescript-eslint/require-await
  async queue(
    batch: MessageBatch<QueueMessage>,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    console.debug("Queue received", JSON.stringify(batch));

    ctx.waitUntil(
      Promise.all(
        batch.messages.map(async (m) => {
          console.debug("Processing message", JSON.stringify(m));

          switch (m.body.type) {
            case "index_issue":
            case "index_issue_comment": {
              const idString = getVectorId(
                m.body.repository,
                m.body.issue.number,
                1
              );

              console.debug("Fetching Durable Object with ID", idString);
              const id = env.ISSUE.idFromName(idString);
              const stub = env.ISSUE.get(id);
              console.debug("Got Durable Object stub", stub);

              await stub.fetch(
                // https://developers.cloudflare.com/durable-objects/configuration/create-durable-object-stubs/#2-send-http-requests
                new Request(new URL("http://do"), {
                  method: "POST",
                  body: JSON.stringify(m.body),
                })
              );

              break;
            }
            case "onboard": {
              const octokit = getOctokit(
                Number(env.GITHUB_APP_ID),
                env.GITHUB_APP_PRIVATE_KEY,
                m.body.installationId
              );

              const repo = m.body.repository;
              console.info("Backfilling issues for repo", JSON.stringify(repo));

              const limit = Number(env.GITHUB_ONBOARDING_LOOKBACK_LIMIT);
              let count = 0;
              for await (const item of octokit.getAllIssuesWithAllUserComments({
                owner: repo.owner,
                name: repo.name,
              })) {
                if (count >= limit) {
                  console.info(`Reached lookback limit (${limit}), stopping`);
                  break;
                }

                console.debug("Backfilling item", item.issue.number, item.type);

                await submit(
                  new IndexGitHubItemMessage({
                    type:
                      item.type === "issue"
                        ? "index_issue"
                        : "index_issue_comment",
                    installationId: m.body.installationId,
                    issue: { number: item.issue.number },
                    title: item.title,
                    body: item.body,
                    repository: item.repository,
                    isOurselves: item.isOurselves,
                  }),
                  env.GENERAL_PURPOSE,
                  () => false
                ); // ⚠️ Careful, recursion

                count++;
              }

              console.info("Backfilling complete");

              break;
            }
            case "offboard": {
              const baseId = getBaseVectorId(m.body.repository, 1);
              console.debug(
                "Deleting vectors for base ID (== namespace)",
                baseId
              );

              let cursor: string | null = null;
              do {
                let res;
                if (cursor) {
                  res = await env.VECTORS.list({
                    prefix: baseId,
                    cursor: cursor,
                  });
                } else {
                  res = await env.VECTORS.list({
                    prefix: baseId,
                  });
                }

                for (const key of res.keys) {
                  console.debug("Deleting vector with ID", key.name);
                  try {
                    await env.VECTORS.delete(key.name);
                  } catch (error) {
                    console.error("Error deleting vector from KV", key.name);
                  }

                  try {
                    await env.VECTORIZE_INDEX.deleteByIds([key.name]); // ⚠️ not ideal
                  } catch (error) {
                    console.error(
                      "Error deleting vector from Vectorize",
                      key.name
                    );
                  }
                }

                if (!res.list_complete) {
                  console.debug("List not complete, fetching more");
                  cursor = res.cursor;
                }
              } while (cursor !== null);

              console.info(
                "Deleted all vectors for repository",
                JSON.stringify(m.body.repository)
              );

              console.info("Offboarding complete");
              break;
            }
            case "post_comment": {
              const ai = new Ai(env.AI);
              const embedding = await embedObject(m.body.issue, ai);

              const thisId = getVectorId(
                m.body.repository,
                m.body.issue.number,
                1
              );
              const vector: VectorizeVector = {
                id: thisId,
                namespace: getVectorNamespace(m.body.repository),
                values: embedding,
              };

              const nResultsWithPotentiallyOurselves =
                Number(env.N_SIMILAR_ISSUES) + 1;
              let matches = (
                await query(
                  vector,
                  env.VECTORIZE_INDEX,
                  nResultsWithPotentiallyOurselves
                )
              ).matches.filter(
                // Don't want to match against ourselves
                (m) => m.id !== thisId
              );
              matches = matches.slice(0, Number(env.N_SIMILAR_ISSUES));

              const octokit = getOctokit(
                Number(env.GITHUB_APP_ID),
                env.GITHUB_APP_PRIVATE_KEY,
                m.body.installationId
              );

              try {
                await octokit.createIssueComment({
                  repository: {
                    name: m.body.repository.name,
                    owner: {
                      login: m.body.repository.owner,
                    },
                  },
                  number: m.body.issue.number,
                  body: formatResponse(matches),
                });
              } catch (error) {
                const msg = "Failed to post comment";
                console.error(msg);
              }

              break;
            }
            case "reindex_issue_comments": {
              const octokit = getOctokit(
                Number(env.GITHUB_APP_ID),
                env.GITHUB_APP_PRIVATE_KEY,
                m.body.installationId
              );

              for await (const item of octokit.getAllUserCommentsForIssue(
                m.body.issue.number,
                m.body.repository
              )) {
                await submit(
                  new IndexGitHubItemMessage({
                    type: "index_issue_comment",
                    installationId: m.body.installationId,
                    issue: { number: item.issue.number },
                    title: item.title,
                    body: item.body,
                    repository: item.repository,
                    isOurselves: item.isOurselves,
                  }),
                  env.GENERAL_PURPOSE,
                  () => false
                ); // ⚠️ Careful, recursion
              }

              break;
            }
            default: {
              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const exhaustiveCheck: never = m.body;
            }
          }
        })
      )
    );
  },
};
