# Agent Rules

## API Validation
- Validate every request input with Zod before business logic.
- This includes `req.params`, `req.query`, and `req.body` for every route.
- Reject invalid input with `400 Bad Request` and a clear validation message.

## How To Test Backend Changes
- Fast compile check: `just build`
- Run unit/integration tests: `just test`
- Apply migrations + seed locally: `just db-migrate && just db-seed`
- If local toolchain/network is flaky, verify in containerized Linux:
  - Compile image: `just build-docker`
  - Full dev stack (migrate + seed + run): `just dev`
