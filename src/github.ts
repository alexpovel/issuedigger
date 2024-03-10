import { createAppAuth } from "@octokit/auth-app";
import type { Endpoints } from "@octokit/types";
import { Buffer } from "node:buffer"; // https://developers.cloudflare.com/workers/runtime-apis/nodejs/buffer/
import { createHmac } from "node:crypto"; // https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/
import { Octokit as OctokitBase } from "octokit";

// Need to name this type for type annotations.
type CreateIssueCommentResponse =
  Endpoints["POST /repos/{owner}/{repo}/issues/{issue_number}/comments"]["response"];

interface GitHubIssueOrCommentCommon {
  issue: {
    number: number;
  };
  id: number;
  body: string | null | undefined;
  repository: {
    owner: string;
    name: string;
  };
  isOurselves: boolean;
}

export type GitHubIssue = GitHubIssueOrCommentCommon & {
  type: "issue";
  title: string;
};

export type GitHubIssueComment = GitHubIssueOrCommentCommon & {
  type: "issue_comment";
  title: undefined;
};

export type GitHubIssueOrComment = GitHubIssue | GitHubIssueComment;

// No benefit in safety with this one (no validation/parsing), but a dedicated name is a
// start for some new-type safety.
export type Pkcs8PemPrivateKey = string & { readonly __tag: unique symbol };
export type AppSecret = string & { readonly __tag: unique symbol };

interface IOctokit {
  createIssueComment({
    repository: { owner, name },
    number,
    body,
  }: {
    repository: {
      owner: {
        login: string;
      };
      name: string;
    };
    number: number;
    body: string;
  }): Promise<CreateIssueCommentResponse>;

  getAllIssuesWithAllUserComments(repository: {
    owner: string;
    name: string;
  }): AsyncIterable<GitHubIssueOrComment>;

  getAllUserCommentsForIssue(
    issueNumber: number,
    repository: { owner: string; name: string }
  ): AsyncIterable<GitHubIssueComment>;

  postReactionToComment(
    commentId: number,
    repository: { owner: string; name: string },
    reaction: "+1"
  ): Promise<void>;
}

export class Octokit extends OctokitBase implements IOctokit {
  static perPage = 30; // default is 30

  appId: number;

  constructor(
    appId: number,
    options: ConstructorParameters<typeof OctokitBase>[0]
  ) {
    super(options);
    this.appId = appId;
  }

  async createIssueComment({
    repository: { owner, name },
    number,
    body,
  }: {
    repository: { owner: { login: string }; name: string };
    number: number;
    body: string;
  }): Promise<CreateIssueCommentResponse> {
    console.debug(`Posting issue comment at ${owner.login}/${name}/${number}`);
    return await this.rest.issues.createComment({
      owner: owner.login,
      repo: name,
      issue_number: number,
      body: body,
    });
  }

  async *getAllUserCommentsForIssue(
    issueNumber: number,
    repository: { owner: string; name: string }
  ): AsyncIterable<GitHubIssueComment> {
    console.debug("Fetching all comments for issue", issueNumber);

    const comments_iter = this.paginate.iterator(
      this.rest.issues.listComments,
      {
        owner: repository.owner,
        repo: repository.name,
        issue_number: issueNumber,
        per_page: Octokit.perPage,
      }
    );

    for await (const { data: comments } of comments_iter) {
      for (const comment of comments) {
        if (
          comment.user === null ||
          comment.user.type !== "User" // ⚠️ This doesn't have type safety.
        ) {
          // Skip the bots or (weirdly) unknown users.
          continue;
        }

        console.debug(
          `Yielding issue comment ${repository.owner}/${repository.name}/${issueNumber}/${comment.id}`
        );
        yield {
          id: comment.id,
          type: "issue_comment",
          issue: { number: issueNumber },
          title: undefined,
          body: comment.body,
          repository,
          isOurselves: this.appId === comment.performed_via_github_app?.id,
        };
      }
    }
  }

  async *getAllIssuesWithAllUserComments(repository: {
    owner: string;
    name: string;
  }): AsyncIterable<GitHubIssueOrComment> {
    const iterator = this.paginate.iterator(this.rest.issues.listForRepo, {
      owner: repository.owner,
      repo: repository.name,
      state: "all", // default is only "open" ones
      per_page: Octokit.perPage,
    });

    console.debug("Fetching all issues for repo", JSON.stringify(repository));

    for await (const { data: issues } of iterator) {
      for (const issue of issues) {
        if (issue.pull_request) {
          // All PRs are issues, but not all issues are PRs... We only want to store
          // issues for now.
          continue;
        }

        console.debug(
          `Yielding issue ${repository.owner}/${repository.name}/${issue.number}`
        );
        yield {
          id: issue.id,
          type: "issue",
          issue: { number: issue.number },
          title: issue.title,
          body: issue.body,
          repository,
          isOurselves: this.appId === issue.performed_via_github_app?.id,
        };

        yield* this.getAllUserCommentsForIssue(issue.number, repository);
      }
    }
  }

  async postReactionToComment(
    commentId: number,
    repository: { owner: string; name: string },
    reaction: "+1"
  ): Promise<void> {
    console.debug(
      `Posting reaction ${reaction} to comment ${repository.owner}/${repository.name}/${commentId}`
    );
    await this.rest.reactions.createForIssueComment({
      owner: repository.owner,
      repo: repository.name,
      comment_id: commentId,
      content: reaction,
    });
  }
}

// Singleton instance
let octokit: IOctokit | null = null;

export function getOctokit(
  appId: number,
  pkcs8PemPrivateKey: Pkcs8PemPrivateKey,
  installationId: number
) {
  console.debug(
    `Will provide Octokit client authenticated for App ID ${appId}, installation ${installationId}`
  );

  if (octokit === null) {
    console.info("Creating initial Octokit instance");

    octokit = new Octokit(appId, {
      // https://github.com/octokit/auth-app.js/?tab=readme-ov-file#usage-with-octokit:
      authStrategy: createAppAuth,
      auth: {
        appId: appId,
        privateKey: pkcs8PemPrivateKey, // nice type safety lul
        installationId: installationId,
      },
    }) as IOctokit;

    console.debug("Got initial Octokit instance");
  }

  return octokit;
}

export class WebhookValidationError extends Error {
  signature: { got: string; expected: string };

  constructor(message: string, signature: { got: string; expected: string }) {
    super(message);
    this.name = "WebhookValidationError";
    this.signature = signature;

    Error.captureStackTrace(this, this.constructor);
    Object.setPrototypeOf(this, WebhookValidationError.prototype);
  }
}

const uniqueToken = Symbol();

/** A token that can only be created by special validation.
 *
 * Later steps/functions require you present this token to prove that you have validated
 * the webhook signature.
 */
export interface ValidationToken {
  [uniqueToken]: undefined; // Private, unique symbol
}

/** https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries#typescript-example */
export function tryValidateWebhookSignature(
  body: string,
  secret: AppSecret,
  untrusted_signature: string
): ValidationToken {
  const trusted_signature = createHmac("sha256", secret)
    .update(body)
    .digest("hex");

  const trusted = Buffer.from(`sha256=${trusted_signature}`, "ascii");
  const untrusted = Buffer.from(untrusted_signature, "ascii");

  if (!crypto.subtle.timingSafeEqual(trusted, untrusted)) {
    throw new WebhookValidationError("Invalid signature", {
      got: untrusted_signature,
      expected: trusted_signature,
    });
  }

  return { [uniqueToken]: undefined };
}
