"use client";

import Link from "next/link";

type RepositoryOption = {
  fullName: string;
  id: string;
};

type SiteHeaderProps = {
  context?: "public" | "dashboard";
  repositories?: RepositoryOption[];
  currentRepository?: string;
};

export function SiteHeader({
  context = "public",
  repositories = [],
  currentRepository,
}: SiteHeaderProps) {
  return (
    <header className="site-header">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="header-inner">
        <Link className="wordmark" href="/" aria-label="SentiRev home">
          <span aria-hidden="true" className="wordmark-rule" />
          SentiRev
        </Link>

        {context === "public" ? (
          <nav className="site-nav" aria-label="Public navigation">
            <Link className="nav-link" href="/#data-use">
              How it works
            </Link>
            <Link className="nav-link nav-link-primary" href="/install">
              Install GitHub App
            </Link>
          </nav>
        ) : (
          <nav className="site-nav" aria-label="Dashboard navigation">
            {repositories.length > 0 ? (
              <label className="repository-switcher">
                <span>Repository</span>
                <select
                  aria-label="Switch repository"
                  defaultValue={currentRepository ?? repositories[0]?.id}
                  onChange={(event) => {
                    const repositoryId = event.currentTarget.value;
                    window.location.assign(`/dashboard?repository=${repositoryId}`);
                  }}
                >
                  {repositories.map((repository) => (
                    <option key={repository.id} value={repository.id}>
                      {repository.fullName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <Link className="nav-link" href="/api/auth/logout">
              Log out
            </Link>
          </nav>
        )}
      </div>
    </header>
  );
}
