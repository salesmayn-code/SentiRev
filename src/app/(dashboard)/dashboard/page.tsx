import { AnnotatedGutter } from "@/components/annotated-gutter";
import {
  DashboardShell,
  type RepositorySummary,
  type DashboardState,
} from "@/components/dashboard-shell";
import { SiteHeader } from "@/components/site-header";
import {
  RepositoryAuthorizationError,
  requireRepositoryAdmin,
} from "@/lib/auth/authorization";
import { getSession } from "@/lib/auth/session";
import { prisma } from "@/lib/db/client";

type SearchParams = Promise<{
  error?: string;
  repository?: string;
}>;

type DashboardPageProps = {
  searchParams?: SearchParams;
};

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const params = searchParams ? await searchParams : {};
  const session = await getSession();
  let state: DashboardState = session ? "empty" : "unauthorized";
  let repositories: RepositorySummary[] = [];
  let error: string | undefined = params.error;

  if (session) {
    try {
      const storedRepositories = await prisma.repository.findMany({
        where: { installation: { ownerUserId: session.userId } },
        orderBy: { fullName: "asc" },
        select: {
          id: true,
          fullName: true,
          connectionStatus: true,
          _count: { select: { pullRequests: true } },
        },
      });

      const authorizedRepositories: RepositorySummary[] = [];
      let deniedRepositoryCount = 0;
      for (const repository of storedRepositories) {
        try {
          await requireRepositoryAdmin(session, repository.fullName);
          authorizedRepositories.push({
            id: repository.id,
            fullName: repository.fullName,
            connectionStatus: repository.connectionStatus,
            reviewedPullRequests: repository._count.pullRequests,
          });
        } catch (authorizationError) {
          if (!(authorizationError instanceof RepositoryAuthorizationError)) {
            throw authorizationError;
          }
          deniedRepositoryCount += 1;
          // Repository access is rechecked on every dashboard load. Rows that
          // GitHub no longer confirms as admin-visible are not disclosed.
        }
      }

      repositories = authorizedRepositories;
      state =
        repositories.length > 0
          ? "success"
          : deniedRepositoryCount > 0
            ? "unauthorized"
            : "empty";
    } catch {
      state = "error";
      error = "The repository list could not be loaded. No connection status was changed.";
    }
  }

  const currentRepository = repositories.some(
    (repository) => repository.id === params.repository,
  )
    ? params.repository
    : repositories[0]?.id;

  return (
    <>
      <SiteHeader
        context="dashboard"
        repositories={repositories.map(({ id, fullName }) => ({ id, fullName }))}
        currentRepository={currentRepository}
      />
      <main id="main-content" className="dashboard-main">
        <div className="dashboard-layout dashboard-layout-wide">
          <AnnotatedGutter index="02" label="Repository dashboard rail" />
          <div className="dashboard-content">
            <DashboardShell
              repositories={repositories}
              initialState={state}
              initialError={error}
              currentRepository={currentRepository}
            />
          </div>
        </div>
      </main>
    </>
  );
}
