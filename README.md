# codex-web-app-workflow

This repository is a reusable workflow template for web applications. It
provides the project agreements, phase contracts, task contracts, design guard
rails, and validation guidance needed for future Next.js, React, TypeScript,
Tailwind, and full-stack projects. It intentionally does not contain a
product application, product data, or a brand identity.

## Publish this repository as a GitHub template

The local directory may have a different name; the remote repository should be
named `codex-web-app-workflow`. From this repository root:

```powershell
git init -b main
git add .
git commit -m "chore: initialize codex-web-app-workflow"
git branch -M main
```

Create an empty GitHub repository named `codex-web-app-workflow` without a
generated README, license, or `.gitignore`. Then connect and push this local
repository, replacing `OWNER` with the personal account or organization:

```powershell
git remote add origin https://github.com/OWNER/codex-web-app-workflow.git
git push -u origin main
```

On GitHub, open the repository and select **Settings → General**. In the
repository settings, enable **Template repository**. Administrator permission
is required. GitHub documents this control in
[Creating a template repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository).

To start an application from the published template, select **Use this
template → Create a new repository**, choose the owner, name, visibility and
branch options, then create the repository. Keep the workflow files and create
the application-specific documents described below. GitHub's complete consumer
flow is documented in
[Creating a repository from a template](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-repository-from-a-template).

## Sol → Terra → Luna

The workflow has three explicit roles:

- **Sol (architect)** owns requirements, architecture, phase order, approvals,
  and final acceptance. Sol must approve the product brief, design direction,
  and numbered phase contract before work starts.
- **Terra (phase owner)** owns one numbered phase. Terra reads the complete
  phase contract, breaks it into bounded tasks, delegates those tasks, reviews
  diffs and evidence, and accepts, rejects, or escalates the results.
- **Luna (worker or auditor)** performs only the assigned bounded task. An
  implementation worker changes only its allocated files; a quality auditor is
  read-only. Every delegated task has at most two implementation attempts. A
  second failed attempt is escalated to Sol.

Delegation must name the objective, allowed files, prohibited changes,
acceptance criteria, verification commands, attempt number, and required return
format. Parallel write work is allowed only when file ownership is explicit and
non-overlapping. Shared configuration, routes, package manifests, migrations,
and central design tokens remain coordinated by the phase owner.

The [Codex subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
describes the underlying subagent configuration model.

## Files used by an application

The following application-specific files are copied from the templates in this
repository and then completed for the new project:

| Source template | Application file | Purpose |
| --- | --- | --- |
| `PRODUCT.template.md` | `PRODUCT.md` | Product scope, users, outcomes, and behavior. |
| `DESIGN.template.md` | `DESIGN.md` | Visual contract, tokens, component rules, and responsive guidance. |
| `ROADMAP.template.md` | `docs/ROADMAP.md` | Numbered phase sequence and dependencies. |
| `PHASE.template.md` | `docs/phases/PHASE-001.md` (and later phases) | Contract for one approved phase. |
| `TASK.template.md` | `docs/tasks/<NNN>-<short-name>.md` | Bounded ownership, acceptance, and evidence contract. |
| `DECISION.template.md` | `docs/decisions/<NNN>-<short-name>.md` | Durable architectural or product decisions. |

Keep these reusable workflow files in the application repository:
`AGENTS.md`, `.codex/config.toml`, `.codex/agents/`,
`.agents/skills/brand-ui-guard/SKILL.md`, and `docs/VALIDATION.md`. Do not
copy secrets or personal settings into the project. `PRODUCT.md` and
`DESIGN.md` are required before a phase that depends on them can be approved.

## Starting a project and approving phases

Start with the following sequence:

1. Copy `PRODUCT.template.md` to `PRODUCT.md` and record the product scope.
2. Copy `DESIGN.template.md` to `DESIGN.md` and define the visual direction,
   tokens, hierarchy, density, signature motif, and responsive behavior.
3. Review both documents with Sol. Resolve contradictions explicitly; do not
   invent missing product or brand decisions in implementation files.
4. Copy `ROADMAP.template.md` to `docs/ROADMAP.md`, then create the first numbered
   phase from `PHASE.template.md`.
5. Sol approves the phase contract. Terra creates task contracts and delegates
   them to Luna with non-overlapping file ownership.
6. Luna returns the structured evidence requested by the task contract. Terra
   inspects the actual diff and independently checks the required lint, type,
   test, build, accessibility, and visual evidence before accepting the phase.

For frontend work, the worker must read `DESIGN.md` before editing. Changed
flows are inspected at desktop and mobile sizes, including loading, empty,
error, hover, focus, active, disabled, and success states where applicable.

## Google Stitch skills

Google Stitch is optional. Installing its plugins changes the user's Codex
plugin setup, so this repository never runs these commands automatically.
After reviewing the current
[Google Stitch skills repository](https://github.com/google-labs-code/stitch-skills),
the user may register its marketplace manually:

```powershell
codex plugin marketplace add google-labs-code/stitch-skills --ref main `
  --sparse .agents/plugins `
  --sparse plugins/stitch-design `
  --sparse plugins/stitch-build `
  --sparse plugins/stitch-utilities
```

Restart Codex, open `/plugins`, select the **Stitch Skills** marketplace, and
install `stitch-design`, `stitch-build`, and `stitch-utilities`. Start a new
session with `/new`, then confirm the installed skills with `/skills`.

Operations that create, read, or manage Stitch canvases also require the
[Stitch MCP setup](https://stitch.withgoogle.com/docs/mcp/setup), Google
authentication, and the appropriate credentials. Those are manual,
environment-level prerequisites. This template does not store credentials,
alter global Codex settings, install plugins, or authenticate the MCP server.

## Project-local versus global settings

The `.codex/config.toml` and `.codex/agents/*.toml` files are project-local
settings. They enable subagents for this repository, set a bounded concurrency
limit, and describe the Terra and Luna roles. Commit them with the project so
all collaborators receive the same workflow contract.

Global Codex configuration belongs to the user's Codex installation and is
outside this repository. Do not edit it from a project task. Keep secrets,
tokens, MCP credentials, and machine-specific paths out of tracked files.

## Validation

This template has no product runtime to build. Its dependency-free structural
check requires Python 3.11 or newer:

```powershell
python scripts/validate_template.py
```

Run the additional reusable checks in
[docs/VALIDATION.md](docs/VALIDATION.md), then run the derived application's own
lint, type-check, tests, production build, and browser checks when those
commands exist. A passing command is evidence for that command only; Terra
still reviews scope, accessibility, responsive behavior, console errors, focus
visibility, overflow, and screenshot evidence.
