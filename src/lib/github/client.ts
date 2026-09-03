import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";

import { getServerEnvironment } from "../env";

const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

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

async function githubApiRequest<T>(
  operation: string,
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
    ...init,
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
  const [owner, name] = fullName.split("/");
  if (!owner || !name || fullName.split("/").length !== 2) {
    throw new Error("Invalid GitHub repository name");
  }

  return normalizeRepository(
    await githubApiRequest<GitHubRepository>(
      "repository authorization lookup",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
      accessToken,
    ),
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
  const appJwt = await createGitHubAppJwt();
  return githubApiRequest<GitHubInstallation>(
    "installation lookup",
    `/app/installations/${installationId}`,
    appJwt,
  );
}

export async function createInstallationToken(installationId: number): Promise<string> {
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
