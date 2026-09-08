import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { getServerEnvironment } from "../env";
import { isRepositoryRelativePath } from "../review/schema";
import {
  isGitHubCommentRequest,
  type GitHubCommentRequest,
} from "./review-feedback";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PULL_REQUEST_DIFF_BYTES = 2 * 1024 * 1024;

const GITHUB_NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const GITHUB_NAME_PART_SOURCE = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";
const GITHUB_TOKEN_PATTERN = /^[^\s]{1,4096}$/u;
const GITHUB_COMMIT_ID_PATTERN = /^[A-Fa-f0-9]{7,128}$/u;
const COMMENT_ENDPOINT_PATTERN = new RegExp(
  `^/repos/(${GITHUB_NAME_PART_SOURCE})/(${GITHUB_NAME_PART_SOURCE})/(pulls|issues)/([1-9]\\d{0,9})/comments$`,
  "u",
);
const COMMENT_IDEMPOTENCY_PATTERN = /^sentirev:[a-f0-9]{64}$/u;
const MAX_GITHUB_COMMENT_BODY_LENGTH = 65_536;

export type GitHubUser = {
  id: number;
  login: string;
};

export type GitHubRepository = {
  id: number;
  name: string;
  full_name: string;
  owner: { login: string };
  permissions?: { admin?: boolean };
};

export type GitHubInstallation = {
  id: number;
  account?: { id?: number; login?: string; type?: string };
};

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, operation: string) {
    super(`GitHub ${operation} failed (${status})`);
    this.name = "GitHubApiError";
    this.status = status;
  }
}

/**
 * A caller-input or bounded-response error that is safe to surface in logs.
 * Values supplied by a caller are deliberately not included in its message.
 */
export class GitHubBoundaryError extends Error {
  readonly code:
    | "INVALID_TOKEN"
    | "INVALID_INSTALLATION"
    | "INVALID_REPOSITORY"
    | "INVALID_PULL_REQUEST"
    | "INVALID_LIMIT"
    | "DIFF_TOO_LARGE"
    | "INVALID_DIFF"
    | "INVALID_COMMENT_REQUEST";

  constructor(
    code: GitHubBoundaryError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GitHubBoundaryError";
    this.code = code;
  }
}

function encodeBase64Url(value: string | Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function githubHeaders(token: string, contentType?: string): HeadersInit {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
    ...(contentType ? { "Content-Type": contentType } : {}),
    "User-Agent": "SentiRev/0.1",
  };
}

function githubRequestSignal(): AbortSignal {
  return AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
}

function validateInstallationToken(token: string): string {
  if (typeof token !== "string" || !GITHUB_TOKEN_PATTERN.test(token)) {
    throw new GitHubBoundaryError(
      "INVALID_TOKEN",
      "The GitHub installation token is invalid",
    );
  }
  return token;
}

function validateInstallationId(installationId: number): number {
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    throw new GitHubBoundaryError(
      "INVALID_INSTALLATION",
      "The GitHub installation reference is invalid",
    );
  }
  return installationId;
}

function parseRepositoryReference(fullName: string): { owner: string; name: string; fullName: string } {
  if (typeof fullName !== "string") {
    throw new GitHubBoundaryError(
      "INVALID_REPOSITORY",
      "The GitHub repository reference is invalid",
    );
  }
  const parts = fullName.split("/");
  if (
    parts.length !== 2
    || !GITHUB_NAME_PART.test(parts[0])
    || !GITHUB_NAME_PART.test(parts[1])
  ) {
    throw new GitHubBoundaryError(
      "INVALID_REPOSITORY",
      "The GitHub repository reference is invalid",
    );
  }
  return { owner: parts[0], name: parts[1], fullName: `${parts[0]}/${parts[1]}` };
}

function validatePullRequestNumber(pullRequestNumber: number): number {
  if (
    !Number.isSafeInteger(pullRequestNumber)
    || pullRequestNumber <= 0
    || pullRequestNumber > 2_147_483_647
  ) {
    throw new GitHubBoundaryError(
      "INVALID_PULL_REQUEST",
      "The GitHub pull request reference is invalid",
    );
  }
  return pullRequestNumber;
}

function validateDiffLimit(maxBytes: number): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_PULL_REQUEST_DIFF_BYTES) {
    throw new GitHubBoundaryError(
      "INVALID_LIMIT",
      "The pull-request diff limit is invalid",
    );
  }
  return maxBytes;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength) && Number(contentLength) > maxBytes) {
    throw new GitHubBoundaryError(
      "DIFF_TOO_LARGE",
      "The pull-request diff exceeds the configured size limit",
    );
  }

  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) {
      throw new GitHubBoundaryError(
        "DIFF_TOO_LARGE",
        "The pull-request diff exceeds the configured size limit",
      );
    }
    return body;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new GitHubBoundaryError(
          "DIFF_TOO_LARGE",
          "The pull-request diff exceeds the configured size limit",
        );
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function invalidCommentRequest(): never {
  throw new GitHubBoundaryError(
    "INVALID_COMMENT_REQUEST",
    "The GitHub review feedback request is invalid",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGitHubReviewLine(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= 10_000_000;
}

function validateCommentRequest(
  request: unknown,
): asserts request is GitHubCommentRequest<unknown> {
  if (!isGitHubCommentRequest(request) || !isRecord(request)) {
    invalidCommentRequest();
  }
  if (
    request.method !== "POST"
    || typeof request.endpoint !== "string"
    || !COMMENT_IDEMPOTENCY_PATTERN.test(request.idempotencyKey)
    || !isRecord(request.payload)
    || typeof request.payload.body !== "string"
    || request.payload.body.length === 0
    || request.payload.body.length > MAX_GITHUB_COMMENT_BODY_LENGTH
    || request.payload.body.includes("\0")
  ) {
    invalidCommentRequest();
  }

  const endpoint = COMMENT_ENDPOINT_PATTERN.exec(request.endpoint);
  if (!endpoint) invalidCommentRequest();
  const pullRequestNumber = Number(endpoint[4]);
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber > 2_147_483_647) {
    invalidCommentRequest();
  }

  if (endpoint[3] === "issues") return;

  const payload = request.payload;
  if (
    typeof payload.commit_id !== "string"
    || !GITHUB_COMMIT_ID_PATTERN.test(payload.commit_id)
    || typeof payload.path !== "string"
    || !isRepositoryRelativePath(payload.path)
    || !isGitHubReviewLine(payload.line)
    || payload.side !== "RIGHT"
    || payload.subject_type !== "line"
  ) {
    invalidCommentRequest();
  }
  if (payload.start_line !== undefined) {
    if (
      !isGitHubReviewLine(payload.start_line)
      || payload.start_line > payload.line
      || payload.start_side !== "RIGHT"
    ) {
      invalidCommentRequest();
    }
  } else if (payload.start_side !== undefined) {
    invalidCommentRequest();
  }
}

async function githubApiRequest<T>(
  operation: string,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
    ...init,
    signal: githubRequestSignal(),
    headers: {
      ...githubHeaders(token, init.body ? "application/json" : undefined),
      ...init.headers,
    },
  });

  if (!response.ok) {
    throw new GitHubApiError(response.status, operation);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new GitHubApiError(response.status, `${operation} returned invalid data`);
  }
}

export type GitHubCommentAcknowledgement = {
  accepted: true;
  status: number;
  idempotencyKey: string;
  githubCommentId?: number;
};

/**
 * Submits a descriptor created by the review-feedback builders. Runtime
 * registration and endpoint/payload validation keep arbitrary URLs and
 * caller-crafted bodies outside this boundary. The response is reduced to
 * acknowledgement metadata; GitHub response bodies are never returned.
 */
export async function submitGitHubComment(
  installationToken: string,
  request: GitHubCommentRequest<unknown>,
): Promise<GitHubCommentAcknowledgement> {
  const token = validateInstallationToken(installationToken);
  validateCommentRequest(request);

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API_ORIGIN}${request.endpoint}`, {
      method: "POST",
      signal: githubRequestSignal(),
      headers: githubHeaders(token, "application/json"),
      body: JSON.stringify(request.payload),
    });
  } catch {
    throw new GitHubApiError(503, "review feedback request");
  }

  if (!response.ok) {
    throw new GitHubApiError(response.status, "review feedback request");
  }

  let githubCommentId: number | undefined;
  try {
    const responseBody: unknown = await response.json();
    if (
      isRecord(responseBody)
      && typeof responseBody.id === "number"
      && Number.isSafeInteger(responseBody.id)
      && responseBody.id > 0
    ) {
      githubCommentId = responseBody.id;
    }
  } catch {
    // A successful 204 or a non-JSON success response still acknowledges the
    // submission; the response body is intentionally not required or exposed.
  }

  return {
    accepted: true,
    status: response.status,
    idempotencyKey: request.idempotencyKey,
    ...(githubCommentId === undefined ? {} : { githubCommentId }),
  };
}

function normalizeRepository(repository: GitHubRepository): GitHubRepository {
  if (
    !Number.isSafeInteger(repository.id) ||
    repository.id <= 0 ||
    !repository.name ||
    !repository.full_name ||
    !repository.owner?.login
  ) {
    throw new Error("GitHub returned an invalid repository");
  }

  return repository;
}

export function getGitHubAppInstallUrl(state: string, appSlug: string): string {
  const url = new URL(`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeOAuthCode(code: string): Promise<string> {
  const environment = getServerEnvironment();
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    signal: githubRequestSignal(),
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "SentiRev/0.1",
    },
    body: JSON.stringify({
      client_id: environment.SENTIREV_GITHUB_CLIENT_ID,
      client_secret: environment.SENTIREV_GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: new URL(
        "/api/auth/callback/github",
        environment.SENTIREV_APP_URL,
      ).toString(),
    }),
  });

  if (!response.ok) {
    throw new GitHubApiError(response.status, "OAuth token exchange");
  }

  const body = (await response.json()) as { access_token?: unknown; error?: unknown };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("GitHub OAuth did not return an access token");
  }

  return body.access_token;
}

export function getGitHubUser(accessToken: string): Promise<GitHubUser> {
  return githubApiRequest<GitHubUser>("user lookup", "/user", accessToken);
}

export async function getRepositoryForUser(
  accessToken: string,
  fullName: string,
): Promise<GitHubRepository> {
  const { owner, name } = parseRepositoryReference(fullName);

  return normalizeRepository(
    await githubApiRequest<GitHubRepository>(
      "repository authorization lookup",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      accessToken,
    ),
  );
}

export type PullRequestDiffOptions = {
  maxBytes?: number;
};

/**
 * Fetches only the unified diff representation of a pull request using an
 * installation token. The body is bounded while it is read and is returned
 * to the ephemeral review pipeline; this boundary never persists it.
 */
export async function getPullRequestDiff(
  installationToken: string,
  repositoryFullName: string,
  pullRequestNumber: number,
  options: PullRequestDiffOptions = {},
): Promise<string> {
  const token = validateInstallationToken(installationToken);
  const repository = parseRepositoryReference(repositoryFullName);
  const number = validatePullRequestNumber(pullRequestNumber);
  const maxBytes = validateDiffLimit(options.maxBytes ?? DEFAULT_MAX_PULL_REQUEST_DIFF_BYTES);
  const path = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}/pulls/${number}`;

  let response: Response;
  try {
    response = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
      signal: githubRequestSignal(),
      headers: {
        ...githubHeaders(token),
        Accept: "application/vnd.github.v3.diff",
      },
    });
  } catch {
    throw new GitHubApiError(503, "pull request diff request");
  }

  if (!response.ok) {
    throw new GitHubApiError(response.status, "pull request diff request");
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedResponse(response, maxBytes);
  } catch (error) {
    if (error instanceof GitHubBoundaryError) throw error;
    throw new GitHubApiError(response.status, "pull request diff response");
  }

  let diff: string;
  try {
    diff = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GitHubBoundaryError(
      "INVALID_DIFF",
      "The pull-request response is not valid UTF-8 text",
    );
  }
  if (diff.includes("\0")) {
    throw new GitHubBoundaryError(
      "INVALID_DIFF",
      "The pull-request response is not a supported text diff",
    );
  }
  return diff;
}

/** Convenience boundary for callers that hold an installation ID. */
export async function getInstallationPullRequestDiff(
  installationId: number,
  repositoryFullName: string,
  pullRequestNumber: number,
  options: PullRequestDiffOptions = {},
): Promise<string> {
  validateInstallationId(installationId);
  const installationToken = await createInstallationToken(installationId);
  return getPullRequestDiff(
    installationToken,
    repositoryFullName,
    pullRequestNumber,
    options,
  );
}

export function isRepositoryAdmin(repository: GitHubRepository): boolean {
  return repository.permissions?.admin === true;
}

export async function createGitHubAppJwt(now = Date.now()): Promise<string> {
  const environment = getServerEnvironment();
  const privateKey = await readFile(
    environment.SENTIREV_GITHUB_PRIVATE_KEY_PATH,
    "utf8",
  );
  const issuedAt = Math.floor(now / 1_000) - 60;
  const expiresAt = issuedAt + 9 * 60;
  const header = encodeBase64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = encodeBase64Url(
    JSON.stringify({
      iat: issuedAt,
      exp: expiresAt,
      iss: environment.SENTIREV_GITHUB_APP_ID,
    }),
  );
  const unsignedToken = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  return `${unsignedToken}.${encodeBase64Url(signer.sign(privateKey))}`;
}

export async function getInstallation(
  installationId: number,
): Promise<GitHubInstallation> {
  validateInstallationId(installationId);
  const appJwt = await createGitHubAppJwt();
  return githubApiRequest<GitHubInstallation>(
    "installation lookup",
    `/app/installations/${installationId}`,
    appJwt,
  );
}

export async function createInstallationToken(installationId: number): Promise<string> {
  validateInstallationId(installationId);
  const appJwt = await createGitHubAppJwt();
  const body = await githubApiRequest<{ token?: unknown }>(
    "installation token request",
    `/app/installations/${installationId}/access_tokens`,
    appJwt,
    { method: "POST" },
  );
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new Error("GitHub did not return an installation token");
  }
  return body.token;
}

export async function getInstallationRepositories(
  installationId: number,
): Promise<GitHubRepository[]> {
  validateInstallationId(installationId);
  const installationToken = await createInstallationToken(installationId);
  const repositories: GitHubRepository[] = [];
  let page = 1;
  let totalCount = Number.POSITIVE_INFINITY;

  while (repositories.length < totalCount) {
    const response = await githubApiRequest<{
      total_count?: unknown;
      repositories?: unknown;
    }>(
      "installation repository lookup",
      `/installation/repositories?per_page=100&page=${page}`,
      installationToken,
    );
    const pageRepositories = Array.isArray(response.repositories)
      ? response.repositories.map((repository) =>
          normalizeRepository(repository as GitHubRepository),
        )
      : [];
    repositories.push(...pageRepositories);
    totalCount =
      typeof response.total_count === "number" && response.total_count >= 0
        ? response.total_count
        : repositories.length;
    if (pageRepositories.length === 0 || pageRepositories.length < 100) {
      break;
    }
    page += 1;
  }

  return repositories;
}
