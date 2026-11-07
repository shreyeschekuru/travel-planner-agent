# Travellite

Chrome extension + API that plans a whole trip within one budget. See README.md for the overview.

## Specs (read the relevant section, not the whole file)

- `Specs/requirements.md`: what to build. 🟢 = MVP, 🔵 = FULL (later releases).
- `Specs/design.md`: how it's built.
  - §1 architecture, §3 request flow, §4 schemas
  - §5 components (5.4 optimizer, 5.7 refinement, 5.9 extension)
  - §6 API, §7 failure handling, §8 security, §10 testing
  - §11–19 are FULL only
- `Specs/tasks.md`: milestones M0–M5 with acceptance checks, and the MVP commit plan.
- `architecture-options/`: why this architecture was chosen over the alternatives.

Use `grep -n "^##" <file>` to find a section, then read only that range. When behavior changes,
update the matching spec section in the same change.

## Commands

- `npm run dev`: API on :3000 (needs Redis: `docker compose up -d redis`).
- `npm run build -w @travellite/extension`: builds the extension into `apps/extension/dist`.
- `npm run ci`: lint, format check, typecheck, tests and build. Run it before reporting work as done.
- API tests use Redis DB 15 and flush it, so they never touch dev data.

## Rules

- Don't commit. Stage files only when asked; the user commits.
- Never print or commit secrets. `.env` holds real keys, and `.env.example` must hold only placeholders.
- Tests use the synthetic fixtures in `fixtures/` only. Never use `fixtures/recorded/`, which is gitignored.
