# Workspace Removal — Flatten to Boards & Board Invitations

> Scope: remove the **workspace** domain entirely and simplify the product to
> **users → boards → board collaborators**, with invitations to *boards* only.
> This is the deliberate complement to `invitation-microservice.md`: that doc split
> the monolith sideways; this one removes a whole vertical slice first so the
> remaining surface is small enough to split cleanly.
>
> It is a plan and a tutorial, not yet-built code — every step is referenced to the
> current tree so it doubles as a guided refactor checklist.

---

## 1. TL;DR — The Verdict

**Yes — kill workspaces.** But not the naive way.

- **Bad:** `DELETE FROM workspaces` / drop the tables, then fix the compiler errors.
  You don't "lose a table" — you lose *access*: today most board access lives in
  `workspace_members` and is *inherited*, not recorded anywhere on the board. If you
  drop workspaces without first copying that inheritance into `board_members`,
  every workspace member silently loses every board. Cascade deletes
  (`workspaces.ts:15-17`) then erase the evidence.
- **Good:** two data moves first, then cut over, then delete:
  1. **Materialize** every *effective* board permission (the current `access.ts:31`
     join result) into explicit `board_members` rows, and
  2. **Anoint an owner** — copy `workspaces.owner_id` onto each board
     (`boards.owner_id`), giving every board exactly one administrator.

After those two moves, the workspace layer is a *pure indirection with zero
information you can't derive from `boards` + `board_members`*. Then you flip the
endpoints, delete the workspace code, and drop the tables.

| What dies | What survives / simplifies |
|---|---|
| `workspaces`, `workspace_members`, `workspace_invitations` | `boards`, `board_members`, `board_invitations` — all unchanged in shape |
| `workspaceRoleToBoardPermission` (`board.service.utils.ts:35`) | only two real levels left: `view` / `edit` |
| Two-axis access (content vs manage, via workspace role) | one rule: **the owner manages, members view/edit** |
| Workspace→board cascades of access | a single-table access decision (`board_members` + `owner_id`) |
| Workspace routes + workspace invitation flows | board invitations only |

The bonus: this **shrinks the microservice plan** in `invitation-microservice.md` —
the two-permission-axes access projection (§6B) collapses to one table. (§12.)

---

## 2. Why killing workspaces wins — the cost inventory

Count the touch points so the payoff is concrete:

| Cost of the workspace layer today | Where |
|---|---|
| Two lookups per board request, joined against a table you don't need | `board/access.ts:11`, `:21`, `:31` |
| A `listAccessibleBoards` that double-queries and dedupes (`workspaceBoards` + `directBoardMembers`, with a manual `Map` merge) | `board/catalog.ts:72-140` |
| Four permission helpers whose only input is the workspace role | `routes/boards/shared.ts:159,163,167` + `:141` |
| Every board admin route pre-checks a workspace role instead of an owner | `members.routes.ts:22,36,51,70`, `link-sharing.routes.ts:26,45`, `invitations.routes.ts:28,76`, `management.routes.ts:50,70,89,107` |
| A full workspace router (9 endpoints) that can't be dropped independently because boards depend on it | `routes/workspaces.ts` |
| A whole `services/workspace/*` package + `workspace.service.ts` facade | `services/workspace/core.ts`, `workspace/invitations.ts` |
| Workspace branches inside board-domain code | `board/invitation-transitions.ts:107-122` (decline a *workspace* invite inside the *board* service), `board/pending-invites.ts:42-57` |
| Billing/debug/OpenAPI/seed all know about workspaces | `services/billing/profile-domain.ts:41-52`, `routes/debug.ts:69,77`, `openapi/document.ts:34,99-208`, `db/seed.ts:35-46` |

The workspace concept buys: *one* shared permission role per team and bulk access to
all boards in a team. The product pays for that with the two-axis access model,
inheritance bugs (removing a workspace member silently revokes boards they were
added to), and a fatter hot path. For a board-first product, the income doesn't
justify the tax.

---

## 3. Target domain model

### Schema after

```
users 1 ────< boards.owner_id           (NEW column, NOT NULL)
boards 1 ────< board_members.board_id    (unchanged)
boards 1 ────< board_invitations.board_id (unchanged)

DELETED: workspaces, workspace_members, workspace_invitations
boards.workspace_id              → REMOVED
boards.owner_id  uuid, references users, NOT NULL   → NEW
```

### The ownership & access rules (the whole authorization story)

| Action | Allowed when | Old rule it replaces |
|---|---|---|
| View / edit board content | owner, OR `board_members.permission`, OR valid link-share token | `checkBoardAccess` (workspace OR direct) |
| Rename / duplicate board | owner, OR member with `edit` | `canCreateBoards` (workspace role owner/admin/editor) |
| **Manage access** (add/remove members, invite/revoke, link-share, delete) | **owner only** | `canManageBoardAccess` / `canDeleteBoards` (workspace role owner/admin) |
| Leave board | any member except the owner | refused today for workspace members (`management.routes.ts:164-167`) |

That is the entire permission surface — one helper.

### Access decision after (replaces `access.ts` wholesale)

```plaintext
board exists?
  ├─ share token valid on this board            → permission = link_share_permission
  ├─ board.owner_id == userId                   → permission = edit
  ├─ board_members row (boardId, userId)        → permission = row.permission
  └─ otherwise                                  → deny
```

No workspace join. No `workspaceRoleToBoardPermission`. No "highest of two
sources". This is exactly the *effective* outcome of today's `access.ts:31` — the
workspace branch has been pre-computed into rows by the migration (§5).

### What a board owner is, definitionally

For every board: `owner_id = workspaces.owner_id` of the workspace the board lived
in (the schema `workspace_single_owner_idx` at `workspaces.ts:23` guarantees one
owner per workspace, so this mapping is unambiguous). A board is therefore cold-started
with exactly one administrator and zero workspace baggage.

---

## 4. The unwinding strategy — four moves

Do them in this order, as separate PRs. The rule that keeps it safe: **every move is
information-preserving** — nobody's access changes during any of them.

| Move | What it does | Risk | PR title |
|---|---|---|---|
| **M1 · Materialize** | Insert `board_members` rows for every *inherited* workspace member (§5), and write `boards.owner_id` | Zero (additive, no code path reads it yet) | `feat: materialize board access + owners` |
| **M2 · Cut over** | Point access/management/list/create endpoints at the board-only model (§6) | Reversible (old fields still exist) | `feat: owner/member authorization` |
| **M3 · Invitations** | Strip the workspace branches, delete workspace invitation endpoints (§7) | Low | `feat: board-only invitations` |
| **M4 · Delete** | Remove workspace schema/code, update billing/debug/openapi/seed/runtime (§8-§9) | Do last, after drift-watch | `chore: remove workspace layer` |

The single most important rule, restated from §1: **M1 must land before anything
that stops writing `workspace_members`, and M2 must land before anything that stops
reading it.** Order is the safety.

---

## 5. M1 — Schema & backfill (the two data moves)

### Step 1 — make `owner_id` additive

`src/db/schema/boards.ts:6-9`: add a nullable column first (drizzle-kit generate →
`just db-migrate`):

```ts
export const boards = pgTable('boards', {
  id: uuid('id').primaryKey().defaultRandom(),
  ownerId: uuid('owner_id').references(() => users.id),   // nullable NOW
  workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }), // still needed until M4
  ...
})
```

No code reads `owner_id` yet — the field is inert until M2.

### Step 2 — backfill owners (one statement)

```sql
UPDATE boards b
SET    owner_id = w.owner_id,
       updated_at = now()
FROM   workspaces w
WHERE  b.workspace_id = w.id;
-- assert: SELECT count(*) FROM boards WHERE owner_id IS NULL;  == 0
```

Because workspace owners are unique (`workspace_single_owner_idx`), each board
resolves to exactly one owner.

### Step 3 — materialize inherited access (the move that saves everyone)

Today a workspace member's access to a board **is not a row** — it's the join at
`access.ts:21-53` / `catalog.ts:89-92`. One insert turns every one of those
invisible grants into a durable `board_members` row:

```sql
INSERT INTO board_members (board_id, user_id, permission, added_by, created_at, updated_at)
SELECT b.id,
       wm.user_id,
       CASE WHEN wm.role = 'viewer' THEN 'view' ELSE 'edit' END,  -- mirrors board.service.utils.ts:35
       NULL,  -- provenance lost; workspace had no "addedBy on board" concept
       now(), now()
FROM   workspace_members wm
JOIN   boards b ON b.workspace_id = wm.workspace_id
ON CONFLICT (board_id, user_id) DO NOTHING;   -- keep existing direct rows untouched
```

Verify the invariant before M2 — the **effective permission of every user on every
board is identical before and after**:

```sql
-- before (old oracle) vs after (new oracle) must match for every (user, board):
-- old: board_members.permission            (direct)
--   ∪  workspaceMemberRoleToBoardPermission (inherited)
-- new: owner_id ⇒ edit
--   ∪  board_members.permission
```

Write this as an assertion query in the data migration and fail loudly on drift.
This is the "read model" the workspace never had — you're doing the projection work
of `invitation-microservice.md §6B`, but writing it back into the source table
instead of a consumer's table. That is the elegant symmetry of this refactor.

> **Resume gold:** "I migrated inherited hierarchy permissions into concrete grants."
> It's the exact skill (eventual read-model materialization) the microservice doc
> teaches, applied to a monolith deadlift.

---

## 6. M2 — Cut over access, queries, and management to board-only

### 6.1 `board/access.ts` → replace three lookups with one

Rewrite `createBoardAccess`:

```ts
// accessSource and permission come from boards.ownerId OR board_members — nothing else.
async function checkBoardAccess(boardId: string, userId: string | undefined, shareToken?: string) {
  const board = await catalog.getBoard(boardId)
  if (!board) return { hasAccess: false, permission: null }

  if (shareToken && board.linkShareEnabled && board.linkShareToken === shareToken) {
    return { hasAccess: true, permission: board.linkSharePermission as BoardPermission }
  }
  if (!userId) return { hasAccess: false, permission: null }

  if (board.ownerId === userId) return { hasAccess: true, permission: BOARD_PERMISSION_EDIT }

  const rows = await db
    .select({ permission: boardMembers.permission })
    .from(boardMembers)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)))
    .limit(1)
  return rows[0]
    ? { hasAccess: true, permission: rows[0].permission as BoardPermission }
    : { hasAccess: false, permission: null }
}
```

Delete `getWorkspaceBoardMembershipPermission` (`access.ts:21-29`) and the workspace
import; `workspaceRoleToBoardPermission` is never called again.

### 6.2 `board/catalog.ts:72-140` → one query, no dedupe

`listAccessibleBoards` becomes a single `OR` instead of two queries + a manual `Map`
merge:

```ts
const rows = await db
  .select({ ...board columns, permission: boardMembers.permission })
  .from(boards)
  .leftJoin(boardMembers, and(eq(boards.id, boardMembers.boardId), eq(boardMembers.userId, userId)))
  .where(or(eq(boards.ownerId, userId), eq(boardMembers.userId, userId)))
```

`AccessibleBoard.accessSource` collapses from `'workspace' | 'board_member'` to a
single value (or drop the field entirely). `getBoardsForWorkspace`
(`catalog.ts:61-70`) is **deleted** with its route (§8).

### 6.3 Management & member routes → owner rules

`routes/boards/shared.ts` replaces the three workspace-role helpers
(`:159,163,167`) with two board-native ones:

```ts
export const BOARD_MANAGE_ONLY = (role: { isOwner: boolean }) => role.isOwner
```

Concretely, in every admin route below, replace the two-step
`getWorkspaceRoleForBoard(deps, id, user) → canManageBoardAccess(role)` with
**"is `req.userId` the `boards.owner_id`?"** against the already-loaded board:

| Route | File:line | New gate |
|---|---|---|
| GET/POST/PATCH/DELETE `/boards/:id/members` | `members.routes.ts:22-71` | owner |
| PATCH / rotate `/boards/:id/link-sharing` | `link-sharing.routes.ts:26,45` | owner |
| POST `/boards/:id/invites` , DELETE `/boards/:id/invites/:inviteId` | `invitations.routes.ts:28,76` | owner |
| PATCH `/boards/:id` (rename), POST `/boards/:id/duplicate` | `management.routes.ts:70,89` | owner **or** member with `edit` (was workspace editor) |
| DELETE `/boards/:id` | `management.routes.ts:107` | owner |
| POST `/boards/:id/leave` | `management.routes.ts:158-171` | any member except owner (drop the workspace-member refusal) |

`getWorkspaceRoleForBoard` (`shared.ts:141-148`) is deleted.

### 6.4 Creation & listing

- `POST /workspaces/:wid/boards` (`management.routes.ts:40-58`) → `POST /boards`
  with `owner_id = req.userId`.
- `GET /workspaces/:wid/boards` (`management.routes.ts:19-32`) → deleted (the global
  `GET /boards` already covers listing).
- `board/lifecycle.ts:7` `createBoard(workspaceId, name)` →
  `createBoard(ownerId, name)`; `duplicateBoard` (`lifecycle.ts:30-32`) copies
  `ownerId` instead of `workspaceId`.

### 6.5 Billing metric

`services/billing/profile-domain.ts:41-52` counted `workspaces` + boards per
workspace. New metric: `boardsOwned` (count `boards.owner_id = userId`) plus total
board memberships — drop `workspacesUsed`. Update the OpenAPI billing response
(`openapi/document.ts:34`).

---

## 7. M3 — Invitations: board-only

Board invitations already exist and need little. Workspace invitations die.

### 7.1 Strip workspace branches out of board-domain code

- `board/pending-invites.ts:42-57` — delete the `workspaceRows` half; keep only the
  board query and the `kind: 'board'` mapping (`:60-71`).
- `board/invitation-transitions.ts:88-123` `declinePendingInvitationByToken` —
  currently falls back to declining a *workspace* invitation inside the *board*
  service. Delete the workspace branch (`:107-122`); the board branch
  (`:98-105`) is the whole function.

### 7.2 Delete workspace invitation endpoints + service

- `routes/workspaces.ts` — whole file deleted (§8), which removes:
  `GET /workspaces/:wid/invitations`, `POST /workspaces/:wid/invitations`,
  `GET /invitations/:token`, `POST /invitations/:token/accept`
  (`workspaces.ts:118-215`).
- `services/workspace/invitations.ts` — deleted with the package.
- The board-compatible paths survive unchanged: `POST /boards/:id/invites`,
  `GET /sharing/pending-invites`, `POST /boards/invites/:token/accept`,
  `DELETE /sharing/pending-invites/:token`, `DELETE /boards/:id/invites/:inviteId`
  (`routes/boards/invitations.routes.ts`).

The "pending invites" response no longer needs the `kind` discrimination — it's
always a board invite.

---

## 8. M4 — Delete the workspace code

Checklist, by file. **Do not** do this before M2/M3 have been live for at least a
full `just build && just test && just db-migrate && just db-seed` cycle in staging.

| File | Action |
|---|---|
| `src/db/schema/workspaces.ts` | delete |
| `src/db/schema.ts:2` | remove `./schema/workspaces.js` export |
| `src/db/schema/boards.ts:8` | drop `workspace_id` column + FK; make `owner_id` NOT NULL |
| `src/services/workspace/*`, `src/services/workspace.service.ts` | delete package + facade |
| `src/routes/workspaces.ts` | delete |
| `src/openapi/schemas.ts:4-20` | delete `createWorkspaceBodySchema`, `createWorkspaceInvitationBodySchema` |
| `src/openapi/document.ts:34,99-208` | drop workspace paths + `workspaces` metric |
| `src/routes/debug.ts:69` | drop `(select count(*) from workspaces)`; `:77` drop `workspace_id` from recent boards |
| `src/db/seed.ts:35-46` | create board with `owner_id`, drop workspace + `workspace_members` inserts |
| `src/app/runtime.ts:17,33,68`, `src/app/create-app.ts:13,30,33` | remove `workspaceService`; `billingService` no longer takes it |
| `src/routes/boards.ts:5,19,30`, `src/routes/boards/shared.ts:6,15`, `management.routes.ts:12,24,50` | drop `workspaceService` from `BoardRouteDeps` |
| `src/services/board.service.utils.ts:35` | delete `workspaceRoleToBoardPermission` |
| `test/workspace.service.test.ts` | delete; update `board.service.test.ts` + `boards.route.test.ts` mocks |

### Data purge (after smoke-testing the cutover, not before)

Snapshot first (rollback insurance, cheap):

```sql
CREATE TABLE archive_workspaces    AS SELECT * FROM workspaces;
CREATE TABLE archive_workspace_members  AS SELECT * FROM workspace_members;
CREATE TABLE archive_workspace_invitations AS SELECT * FROM workspace_invitations;
```

Then, in a migration that runs after M2+M3 are verified:

1. `ALTER TABLE boards DROP COLUMN workspace_id;` and `ALTER TABLE boards ALTER COLUMN owner_id SET NOT NULL;`
2. `DROP TABLE workspace_invitations, workspace_members, workspaces;`

FK order is safe automatically (`board_members`, `board_invitations` reference
`boards`, not workspaces). Keep the archives one release behind, then drop them.

---

## 9. Gotchas / edge cases (read before you start)

| Edge | Decision | Why |
|---|---|---|
| A workspace had a *viewer* on a board they were also directly added to as *edit* | ON CONFLICT DO NOTHING keeps the stronger direct row | preserves today's `max()` semantics, no logic replication |
| Workspace **owner** was never a `board_members` row | `owner_id` captures them; no row needed (owner = implicit edit) | single source of truth, no duplication |
| `addedBy` provenance lost for materialized rows | `NULL` | workspaces never recorded board-level `addedBy`; don't fabricate |
| A member who joined via workspace invite but never accepted a board invite | already covered by the materialize INSERT (they're a workspace member) | nobody loses boards |
| The workspace owner also deletes the workspace | not implemented today (no delete-workspace route) — ignore until it exists, then it must materialize first | avoids silent revocation, same lesson as M1 |
| Duplicate boards | copy `owner_id`, not workspace | parity with current `duplicateBoard` copying `workspaceId` |
| Link-share tokens | untouched — owned by `boards`, never involved in workspace | no migration needed |

---

## 10. What you lose, honestly (and the escape hatch)

| Lost capability | Impact | Rebuild path (future, no schema change needed) |
|---|---|---|
| One workspace admin manages many boards at once | after migration, only the workspace *owner* manages each board | **ownership transfer** endpoint (`PATCH /boards/:id/owner`), or a `board_managers` column |
| Bulk "add editor to every board in a team" | one-by-one member adds | **board groups** = a named set of `boardId`s (a table, not a parent FK) |
| Workspace-scoped dashboard | `GET /boards` is global | folders/collections of boards, same trick |
| Org-level billing grouping | `workspacesUsed` metric | group by owner; Stripe already keys `organizationId` independently (`billing.ts:8`) |

None of these require resurrecting `workspace_members`. The board-shaped model is a
better foundation for all three.

---

## 11. Verification & testing

- Compile: `just build`. Tests: `just test`. Migrations + seed:
  `just db-migrate && just db-seed` (seed changed to assert `owner_id` + materialized
  members).
- **Drift gate (M1):** the assertion query in §5.3 — old oracle vs new oracle must
  match for every (user, board). Automate it as a temporary test before M2 merges.
- **Access regression suite:** for a board owned by user A with member B (edit),
  member C (view), and outsider D, assert: A can manage; B/C can open & see their
  own permission; D denied; link token grants anonymous view. These cases map 1:1 to
  the routes in §6.3.
- **Invitation suite:** board invite accept/decline/revoke still work; the
  *workspace* token paths (`GET /invitations/:token`,
  `POST /invitations/:token/accept`) now 404 — update `boards.route.test.ts`.

---

## 12. How this reshapes the microservice plan (`invitation-microservice.md`)

This refactor is prologue to the event-driven split, and it *simplifies* it:

| `invitation-microservice.md` concept | After workspace removal |
|---|---|
| Two-permission-axes projection (§6B.4), `p_workspace_member`, role→permission mapping | dead. One axis: `owner_id` + `board_members` |
| `workspace.member.added / role_changed / removed` events (§6B.1) | no longer exist — the trickiest events (role-change recompute cascades) vanish |
| `board.access.granted` from two sources (`board_invitation` / `direct_add`) | still useful, exactly two `board_members` write paths |
| `membership-api` owning `workspace_members` + `board_members` (§6C.1) | shrinks to `board_members` + `board_invitations` — a genuinely small, independently-owned service |
| Cascade/exceptional edge review R5 (workspace deletes, silent revocations) | never born |

You can **git-revert the two-market split decision cheaply** even if you keep
workspaces later — but the removal first means the future service boundary is
*board-shaped*, which is the natural event aggregate anyway.

---

## 13. Resume / Interview Talking Points

- **Migration-not-deletion:** surface the true cost (inherited access isn't rows) and
  materialize effective permissions *before* dropping the hierarchy — proving
  zero-access-drift with an assertion query rather than a prayer.
- **Simplification as architecture:** replaced a two-axis (content vs manage)
  permission model with one owner rule, deleting a whole domain's worth of joins,
  helpers, and routes rather than extending them.
- **Read-model discipline applied to data:** the materialize step is the same
  projection skill as the microservice doc's event read-models, done in a migration.
- **Cutover discipline:** additive → backfill → flip reads → flip writes →
  snapshot → purge, each step reversible, drift-watched.

### Interview drill (microservices & API design only)

"Where does board-access enforcement live after a microservice split?"
→ *the boards service owns `owner_id` + `board_members` and enforces locally — a
single-table lookup, exactly the projection the migration materialized. On the hot
path it never calls out to another service; grants arrive asynchronously via
`board.access.granted/revoked` events from `invitation-microservice.md §6B`.*

"Why is removing workspaces good for your service boundaries?"
→ *it deletes a whole domain of shared ownership (`workspace_members`) and the worst
events to build correctly (`workspace.member.role_changed` cascades). What's left is
one canonical aggregate — board = owner + members + invites + link-share — which is
exactly the right event key and the right microservice boundary.*

"Design the API for inviting someone to a board."
→ *write `POST /boards/:id/invites` (owner-only, Zod-validated email +
view/edit) → responds with the invite + token; `POST /boards/invites/:token/accept`,
`DELETE /sharing/pending-invites/:token`, `DELETE /boards/:id/invites/:inviteId`;
reads (`GET /sharing/pending-invites`) served from a small read model. Writes are
commands with 2xx semantics, reads are separate endpoints — no POST-routes-that-
return-query-results muddle.*

"How do you change API routes without breaking clients?"
→ *the same additive discipline as the migration: ship `owner_id` + new
`POST /boards` semantics behind the old endpoints in parallel, mark the change, cut
traffic, then delete the old routes. Contract changes land before behavior changes.*

"Didn't you just lose teamwork features?"
→ *the board-shaped model still expresses owners, editors, viewers, invites, and link
shares; admin delegation and teams rebuild as board groups without resurrecting a
workspace FK. The API surface is smaller and every rule now lives in one place.*