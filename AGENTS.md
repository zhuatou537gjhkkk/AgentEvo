# Repository Guidelines

## Project Structure & Module Organization

AgentEvo is an AI chat application with a Node.js/Express backend and a React/Vite frontend. Backend source lives in `backend/src/`, including HTTP routes (`app.js`), services, SQLite persistence (`db/`), RAG (`rag/`), MCP tools and servers (`mcp/`), security, tracing, evaluation, and the local coding-agent runtime (`coding/`). Frontend code lives in `frontend/src/`, with API clients in `api/`, Zustand stores in `store/`, reusable UI in `components/`, and utilities in `utils/`. Tests are colocated as `*.test.js` or under `__tests__/`. Operational notes and runbooks belong in `docs/`; persistent agent-learning notes belong in `memory/`.

## Build, Test, and Development Commands

Install dependencies separately in `backend/` and `frontend/` with `npm install`.

- `cd backend; npm run dev` — start the API with nodemon.
- `cd backend; npm test` — run backend Vitest tests.
- `cd backend; npm run check:syntax` — validate backend JavaScript syntax.
- `cd frontend; npm run dev` — start the Vite development server on port 5173.
- `cd frontend; npm test` — run frontend Vitest tests.
- `cd frontend; npm run build` — create the production frontend bundle.
- `cd frontend; npm run check` — run syntax/build checks and tests.

## Coding Style & Naming Conventions

Use ESM JavaScript, four-space indentation, semicolons, and single-quoted strings consistent with the existing code. Use `camelCase` for functions and variables, `PascalCase` for React components, and descriptive `.test.js` names. Keep API contracts, SSE event shapes, and existing Zustand state behavior backward compatible.

## Testing Guidelines

Vitest is the test framework. Add regression tests beside the changed module or in its `__tests__/` directory. Backend tests use the configured isolated database setup; do not depend on a developer’s local database. Run the relevant package tests, then run frontend `npm run check` and backend syntax checks for cross-layer changes.

## Commit & Pull Request Guidelines

Use focused Conventional Commit-style messages, such as `feat(agent): [Phase-7/R6] ...`, `test(hardening): ...`, or `docs(hardening): ...`. Pull requests should explain the behavior change, list validation commands and results, identify API or migration impact, and include screenshots or recordings for visible frontend changes. Keep unrelated refactors out of the same PR.

## Security & Configuration

Keep API keys and secrets in local `.env` files; never commit them. Use `.env.example` for new configuration. Treat uploads, remote MCP servers, worktrees, and code execution as security-sensitive areas and preserve existing approval, scope, and isolation checks.
