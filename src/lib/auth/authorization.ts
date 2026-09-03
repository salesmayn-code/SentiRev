import {
  getRepositoryForUser,
  isRepositoryAdmin,
  type GitHubRepository,
} from "../github/client";

import type { Session } from "./session";

export class RepositoryAuthorizationError extends Error {
  constructor() {
    super("Repository administrator permission is required");
    this.name = "RepositoryAuthorizationError";
  }
}

/**
 * Recheck the current GitHub user's repository-admin permission on every
 * repository-management operation. The installation owner relationship is
 * not treated as a permanent authorization grant.
 */
export async function requireRepositoryAdmin(
  session: Session,
  fullName: string,
): Promise<GitHubRepository> {
  const repository = await getRepositoryForUser(session.accessToken, fullName);
  if (!isRepositoryAdmin(repository)) {
    throw new RepositoryAuthorizationError();
  }
  return repository;
}
