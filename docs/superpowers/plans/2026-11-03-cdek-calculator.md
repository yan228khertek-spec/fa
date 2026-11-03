# CDEK calculator implementation plan

> **For agentic workers:** Execute this plan inline, task by task, using test-driven-development and verification-before-completion. Request an independent code review before delivery.

**Goal:** Calculate delivery through CDEK API v2 using actual parcel measurements and contract credentials, with an authenticated admin endpoint for verification.

**Architecture:** A standalone CDEK client owns OAuth, token caching and the tariff calculator. An admin-only route accepts explicit CDEK city codes, tariff and measured parcels. The existing storefront contract remains unchanged until its amendment is agreed with the second developer.

**Tech Stack:** Node.js >=22, TypeScript, Fastify 5, Vitest, native fetch.

## Global constraints

- Work in branch `codex/cdek-calculator`; preserve existing uncommitted documents and local files.
- Secrets only in environment variables; no real credentials in source, responses or logs.
- Official reference: https://apidoc.cdek.ru/ (`operation/getOAuthToken`, `operation/tariff`, appendix 14).
- Weight in grams, dimensions in centimetres, internal money in integer kopecks.
- Request currency `1` (RUB); accept only response currency `RUB`.
- Use `total_sum`, which includes VAT and services; never substitute `delivery_sum` or the legacy 500 RUB fee.
- No invented parcel dimensions, tariffs, free-delivery threshold or origin city code.
- No shipment creation, payment, database changes or deployment in this step.
- Public storefront API amendments need explicit agreement under `docs/api-contract.md:13`.

## Task 1: Configuration, validation and calculator

**Files:** Create `packages/backend/src/delivery/cdek.ts`, `packages/backend/src/delivery/validate.ts`, `packages/backend/test/cdek.test.ts`.

**Interfaces:** `loadCdekConfig(env): CdekConfig | undefined`; `parseCdekInput(body: unknown): CdekInput`; `CdekClient.calculate(input: CdekInput): Promise<CdekQuote>`.

- [x] Write failing tests covering disabled/missing credentials, explicit test/production hosts, strict parcel/location validation, mapping to provider request, total including VAT, invalid currency/amount/periods, upstream errors, timeout, cached/shared OAuth and one refresh after HTTP 401.
- [x] Run `npm test -w @fa/backend -- test/cdek.test.ts`; verify failures are from missing implementation.
- [x] Implement the interfaces. Configuration uses `CDEK_ENABLED`, `CDEK_ENVIRONMENT`, `CDEK_CLIENT_ID`, `CDEK_CLIENT_SECRET`, `CDEK_TIMEOUT_MS`; disabled returns undefined, enabled requires credentials and explicit environment. Requests use only fixed official hosts and reject redirects.
- [x] Token request: `POST /v2/oauth/token`, form body `grant_type=client_credentials&client_id=...&client_secret=...`. Share an in-flight token request; use provider expiry with a safety margin.
- [x] Calculator request: `POST /v2/calculator/tariff`, bearer authorization, JSON `{ type: 1, currency: 1, lang: 'rus', tariff_code, from_location, to_location, packages }`; support optional shipment/delivery office codes. Treat HTTP errors, provider errors in HTTP 200 and malformed results as safe typed errors without raw provider messages.
- [x] Run focused tests and backend build, then format changed files.

## Task 2: Protected integration and operator instructions

**Files:** Create `packages/backend/src/delivery/admin-routes.ts`, `packages/backend/test/cdek-admin.test.ts`, `docs/cdek-delivery.md`. Modify `packages/backend/src/config.ts`, `packages/backend/src/app.ts`, `packages/backend/src/admin/plugin.ts`, `.env.example`, `.env.production.example`, `docker-compose.prod.yml`.

**Interfaces:** `registerCdekRoutes(adm, calculator?)` registers `POST /admin/api/cdek/calculate` inside the existing Basic authentication and `X-FA-Admin` protection. Body is limited to 32 KiB; calculation attempts are rate limited; responses are not cached.

- [x] Write failing HTTP tests for no authentication (401), missing CSRF header (403), disabled provider (503), malformed JSON/body (400), body limit (413), rate limit (429), successful quote (200), provider failure without sensitive detail, and real `buildApp` configuration wiring.
- [x] Run `npm test -w @fa/backend -- test/cdek-admin.test.ts`; confirm the new route is missing.
- [x] Wire optional CDEK config/client into the app and existing protected admin area. Use a fetch dependency only at the external transport boundary for deterministic tests.
- [x] Add empty secrets and disabled-by-default settings to both env examples and production compose; no credentials in the browser.
- [x] Document how to obtain integration credentials at https://lk.cdek.ru/integration/index, enter them privately into server environment, select city/tariff codes and measured parcel data, and compare calculator totals with the business account.
- [x] Document the explicit remaining checkout work: city/PVZ selection, authoritative packaging, server-issued quote tied to cart/destination and expiry, persistence and revalidation before payment, agreed API amendment. The diagnostic quote is not authorization to charge a buyer.
- [x] Run `npm run build -w @fa/backend`, `npm run lint`, `npm test`; report skipped database tests separately.
- [x] Request independent review; fix important findings, rerun affected checks and inspect `git diff --check`/working tree before delivery.
