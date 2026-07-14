# Codex Instructions

These instructions apply to the entire repository. They are repo-level guidance for future Codex work and are not a product feature specification by themselves.

## Required Context

Before making frontend or UI changes:

1. Read `DESIGN.md` completely.
2. Inspect the existing frontend implementation and component structure.
3. Treat `DESIGN.md` as the visual design source of truth.
4. Preserve existing application behavior, business logic, and public APIs.

## Design Implementation Rules

- Follow the colors, typography, spacing, layout, borders, and interaction guidance in `DESIGN.md`.
- Adapt its design tokens to the project's existing HTML, CSS, and JavaScript instead of introducing another styling framework.
- Reuse and update existing UI patterns before creating new ones.
- Do not copy Apple logos, trademarks, product imagery, or other proprietary brand assets.
- Do not modify backend behavior solely for a visual change.
- Preserve responsive behavior and accessibility.
- Provide loading, empty, error, disabled, hover, focus, and active states where relevant.
- When `DESIGN.md` conflicts with business requirements, security, accessibility, existing behavior, or framework constraints, preserve those requirements and report the conflict.

## Project Direction

This repo is an affiliate content operations system.

It already has:

- campaign / product management
- affiliate links
- AI-generated drafts
- compliance validation
- scheduled publishing
- click / conversion / revenue dashboard
- `/r/{slug}` redirect tracking
- `/api/conversions` webhook
- `/api/readiness`
- dry-run / live publishing mode
- Postgres support

The improvement direction is not to add more flashy AI features.

The improvement direction is:

> Make the system safe to deploy, able to track revenue, reviewable by humans, and gradually scalable.

## Git Rules

All new commits for this repo must use:

```bash
git config user.name "ZHIHUI"
```

Do not rewrite existing Git history.

If `user.email` is not configured, report it instead of inventing one.

## Engineering Rules

- Prefer small, reviewable diffs.
- Do not rename existing public APIs unless explicitly required.
- Do not remove existing behavior.
- Do not add unrelated AI features.
- Do not perform broad refactors.
- Preserve backward compatibility where possible.
- Keep dry-run mode safe by default.
- Live publishing must always pass readiness checks.
- Dangerous admin actions must require authentication.
- Backend validation is required; frontend-only validation is not enough.

## Implementation Order

Future work should be implemented in this order:

1. P0 admin authentication and authorization
2. P0 readiness gate for live publishing
3. P0 deployment runbook
4. P1 attribution and revenue tracking
5. P1 content review workflow
6. P1 content deduplication and fatigue control
7. P2 offer feed schema
8. P2 web / worker separation

## Done Means

For each future task, Codex must report:

- changed files
- behavior changes
- new environment variables
- tests run
- tests not run and why
- security impact
- remaining risks
