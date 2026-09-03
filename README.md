# SentiRev

### A careful second review for every pull request.

SentiRev is a GitHub-native code review service for repository owners and small
engineering teams. It examines new pull-request changes for security and logic
issues, explains each finding, and points to the exact file and line that needs
attention—without taking control of the merge.

```text
19 │ export function exportAdminReport(user) {
20 │   if (!user) throw new Error("Authentication required");
   │
24 │   return buildAdminReport(user.id);
   ├────────────────────────────────────────────────────────
   │ HIGH  Authorization bypass
   │ An authenticated user can access an administrator report
   │ without an administrator-role check.
```

> SentiRev is advisory. It helps developers review changes more consistently;
> it does not claim to make software vulnerability-free or replace a full
> security assessment.

## Why SentiRev exists

Solo maintainers and small teams do not always have a second security reviewer
available for every pull request. Static analyzers are fast but can be noisy,
while manual review is slower and often compressed by deadlines.

SentiRev is designed to sit between those extremes: deterministic checks for
known patterns, reasoning about the changed code, and a concise explanation a
developer can verify for themselves.

It focuses on issues such as:

- authorization bypasses;
- unsanitized input;
- committed secrets;
- unsafe deserialization;
- security-sensitive logic mistakes.

## How a review works

```text
GitHub pull request
        │
        ▼
Signed webhook ──► verify event and repository
        │
        ▼
Fetch PR diff ──► changed hunks with bounded context
        │
        ├────────► Semgrep static analysis
        │
        └────────► Laguna S 2.1
                         │ provider failure
                         ▼
                   Nemotron 3 Ultra
        │
        ▼
Validate, score, merge, and deduplicate findings
        │
        ├────────► cited inline GitHub review comments
        └────────► repository dashboard and review history
```

For the finished v1, the expected flow is:

1. A GitHub repository administrator installs the SentiRev App and selects one
   or more repositories.
2. The administrator chooses AI-assisted review or static-only analysis. PR
   diffs are never sent to an AI provider without that consent.
3. GitHub sends an `opened` or `synchronize` pull-request event. SentiRev
   verifies its signature before storing or queueing anything.
4. SentiRev retrieves the diff and analyzes changed hunks rather than scanning
   the repository's entire history.
5. Static and consented AI passes run in parallel. Their results are validated,
   severity-scored, merged, and deduplicated.
6. Findings appear as cited inline comments and in the repository dashboard.
   A clean review still produces an explicit “no findings” result.
7. If AI providers are unavailable, static findings still complete and the
   review reports a visible delay instead of failing silently.

## Built around evidence, not alarm

Every finding is intended to answer four questions immediately:

| Question | What SentiRev shows |
| --- | --- |
| What happened? | A direct, one-line summary |
| How serious is it? | `Critical`, `High`, `Medium`, or `Low` in text and color |
| Where is it? | An exact `file:line` citation and bounded code excerpt |
| Why was it flagged? | Expandable reasoning and the engine that produced it |

Findings never block a merge. Repository administrators can dismiss a false
positive with a note, undo the dismissal, inspect severity trends, and retain
or permanently delete review history.

## Data and trust boundary

SentiRev is deliberately narrow about the code it handles:

- It processes pull-request diffs, not complete source trees.
- AI processing is disclosed and requires repository-admin consent.
- Static-only mode remains available when AI processing is declined.
- Raw diff text is deleted after analysis.
- Only structured findings and a small cited excerpt are retained until an
  administrator deletes that history.
- Disconnecting a repository stops new reviews but preserves its existing
  history until explicit deletion.
- GitHub webhook signatures are checked against the original request body.
- GitHub is the only login system; repository access is rechecked against
  GitHub administrator permission.
- Provider credentials belong to the SentiRev service owner and are never
  entered by repository users.

## Current project status

SentiRev is under active development. The foundation and representative public
experience are complete; the analysis pipeline is the next major milestone.

| Area | Status |
| --- | --- |
| GitHub OAuth and App installation | Complete |
| Repository-admin authorization and consent | Complete |
| Signed, idempotent webhook ingestion | Complete |
| PostgreSQL persistence and Redis-backed queued jobs | Complete |
| Public landing proof and pending evaluations page | Complete |
| Semgrep and Laguna/Nemotron review engine | Planned next |
| Inline PR findings and full operational dashboard | Planned |
| Reproducible provider precision/recall publication | Planned |
| Production hardening and deployment | Planned |

The finding shown on the current landing page is a manually prepared,
traceable example from a controlled test repository. It is clearly labelled as
representative proof and is not presented as output from an unfinished review
engine.

## Technology

- **Application:** Next.js 15, React 19, strict TypeScript
- **Persistence:** PostgreSQL and Prisma
- **Jobs:** Redis and BullMQ
- **GitHub boundary:** GitHub App, OAuth, REST API, signed webhooks
- **Analysis target:** JavaScript/TypeScript first, Python second
- **Planned engines:** Semgrep, Laguna S 2.1, Nemotron 3 Ultra fallback
- **Testing:** Vitest and Playwright
- **Interface:** the custom Annotated Gutter design system with self-hosted
  Space Grotesk and IBM Plex fonts

## Run locally

### Prerequisites

- Node.js 22.19 or newer
- npm 10.9.3 or newer
- PostgreSQL
- Redis
- A development GitHub App and a test repository you administer

### 1. Install dependencies

```powershell
npm ci
```

### 2. Configure the environment

```powershell
Copy-Item .env.example .env
```

Fill every value in `.env`. Keep the GitHub private key outside this
repository and point `SENTIREV_GITHUB_PRIVATE_KEY_PATH` to that file. The OAuth
callback, installation setup URL, webhook URL, and `SENTIREV_APP_URL` must refer
to the same development application. Never commit `.env`, private keys, OAuth
secrets, webhook secrets, session secrets, or provider credentials.

The development GitHub App currently needs read access to repository metadata
and pull requests and must subscribe to pull-request events.

### 3. Prepare the database

```powershell
npx prisma migrate deploy
```

### 4. Start the application and worker

Run these in separate PowerShell windows:

```powershell
npm run dev
```

```powershell
npm run worker
```

Open `http://127.0.0.1:3000`, install the development GitHub App on the test
repository, choose the processing mode, and open the dashboard.

## Quality checks

```powershell
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run test:security
npm run test:e2e
npm run test:visual
npm run design:lint
npm run secrets:check
npm run build
```

The integration suite expects reachable development PostgreSQL and Redis
services. Browser tests start or reuse the local Next.js application through
the Playwright configuration.

## First-version boundaries

SentiRev v1 is GitHub-only, English-only, and advisory. It does not include
billing, team roles, GitLab or Bitbucket support, merge blocking, automatic
fixes, rescanning old code, user-defined rules, additional AI models, or a
mobile dashboard.

---

SentiRev should feel like a careful colleague in the margin of a diff: direct,
specific, explainable, and never alarmist.
