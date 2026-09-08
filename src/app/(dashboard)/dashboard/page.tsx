import { AnnotatedGutter } from "@/components/annotated-gutter";
import {
  DashboardShell,
  type DashboardState,
} from "@/components/dashboard-shell";
import { SiteHeader } from "@/components/site-header";
import {
  DashboardAccessError,
  getDashboardData,
  getDashboardRepositories,
} from "@/lib/dashboard/data";
import { getSession } from "@/lib/auth/session";

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
  let repositories: Awaited<ReturnType<typeof getDashboardRepositories>> = [];
  let initialData: Awaited<ReturnType<typeof getDashboardData>> | undefined;
  let error: string | undefined = params.error;

  if (session) {
    try {
      repositories = await getDashboardRepositories(session);
      state = repositories.length > 0 ? "success" : "empty";
    } catch (caughtError) {
      if (caughtError instanceof DashboardAccessError) {
        state = caughtError.code === "authentication_required"
          ? "unauthorized"
          : "error";
        error = caughtError.code === "repository_access_denied"
          ? "GitHub did not confirm administrator access for the connected repositories."
          : "The repository list could not be loaded. No connection status was changed.";
      } else {
        state = "error";
        error = "The repository list could not be loaded. No connection status was changed.";
      }
    }
  }

  let currentRepository = repositories.some(
    (repository) => repository.id === params.repository,
  )
    ? params.repository
    : repositories[0]?.id;

  if (session && currentRepository && state !== "error" && state !== "unauthorized") {
    try {
      initialData = await getDashboardData(session, currentRepository);
    } catch (caughtError) {
      state = "error";
      // An authorization or data-read failure must not leave a previously
      // fetched repository directory available to the rendered shell.
      repositories = [];
      initialData = undefined;
      currentRepository = undefined;
      error = caughtError instanceof DashboardAccessError
        ? "This repository is no longer available to the authenticated GitHub administrator."
        : "The repository review data could not be loaded. No repository state was changed.";
    }
  }

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
              repositories={state === "error" ? [] : repositories}
              initialData={initialData}
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
