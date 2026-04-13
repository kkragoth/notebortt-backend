# Frontend Handoff: IAM + Board Sharing (Backend)

This doc is the frontend integration contract for the new backend IAM/share model.

## 1. High-Level Changes
- `board_shares` model is replaced by:
  - `board_members` (direct user access per board)
  - board-level link sharing fields on `boards`:
    - `linkShareEnabled`
    - `linkShareToken`
    - `linkSharePermission` (`view` | `edit`)
- Workspace roles are now:
  - `owner`, `admin`, `editor`, `viewer`
- Board invite payload now uses `permission` (`view` | `edit`) instead of `role`.
- Board invite acceptance is token-based endpoint.

## 2. Access Resolution (Backend Source of Truth)
For board read/write checks:
1. Link token (`shareToken`) if enabled and token matches board
2. Direct board member (`board_members`)
3. Workspace membership role mapped to board permission:
   - `owner/admin/editor` -> `edit`
   - `viewer` -> `view`

## 3. Auth Expectations
- Authenticated endpoints require normal backend auth middleware (existing cookie/bearer flow).
- Public/shared board reads/writes can use `shareToken` query param with optional auth routes.
- For anonymous edits, frontend should send `sessionId` in mutation/patch body.

## 4. Endpoints Frontend Should Use

## Boards (authenticated)
- `GET /boards`
  - Returns all accessible boards (workspace + direct board member access).
- `GET /workspaces/:wid/boards`
- `POST /workspaces/:wid/boards` body: `{ name }`
- `PATCH /boards/:id` body: `{ name }`
- `POST /boards/:id/duplicate`
- `DELETE /boards/:id`

## Board content (optional auth + `shareToken`)
- `GET /boards/:id?shareToken=...`
- `GET /boards/:id/elements?shareToken=...`
- `PATCH /boards/:id/elements?shareToken=...`
  - body: `{ upserts: unknown[], deletes: unknown[], sessionId?: string }`
- `POST /boards/:id/mutations?shareToken=...`
  - body: `{ mutations: Mutation[], sessionId?: string }`
- `POST /boards/:id/preview-jobs?shareToken=...`

## Presence (optional auth + `shareToken`)
- `GET /boards/:id/active-users?shareToken=...`
- `POST /boards/:id/presence?shareToken=...` body: `{ sessionId }`
- `DELETE /boards/:id/presence/:sessionId?shareToken=...`

## Board members (authenticated; owner/admin only)
- `GET /boards/:id/members`
- `POST /boards/:id/members` body: `{ userId, permission?: 'view' | 'edit' }`
- `PATCH /boards/:id/members/:memberId` body: `{ permission: 'view' | 'edit' }`
- `DELETE /boards/:id/members/:memberId`

## Board invitations (authenticated; owner/admin only unless accept)
- `POST /boards/:id/invites` body: `{ email, permission?: 'view' | 'edit' }`
- `DELETE /boards/:id/invites/:inviteId`
- `GET /sharing/pending-invites` (for logged-in current user)
- `POST /boards/invites/:token/accept` (logged-in invitee)

## Link sharing (authenticated; owner/admin only)
- `PATCH /boards/:id/link-sharing` body: `{ enabled: boolean, permission?: 'view' | 'edit' }`
  - Enabling generates a fresh token.
  - Disabling clears token.
- `POST /boards/:id/link-sharing/rotate`
  - Rotates token and invalidates old links.
- `GET /shared/:token`
  - Resolve share token -> `{ boardId, permission }` for deep-link entry.

## Workspace invitations
- `POST /workspaces/:wid/invitations` body: `{ email, role?: 'admin' | 'editor' | 'viewer' }`

## 5. Deprecated/Removed Frontend Calls
Stop using old share/link routes:
- `POST /boards/:id/shares`
- `GET /boards/:id/shares`
- `PATCH /boards/:id/shares/:shareId`
- `DELETE /boards/:id/shares/:shareId`
- `POST /boards/:id/links`
- `DELETE /boards/:id/links/:linkId`
- `POST /boards/:id/invites/:inviteId/accept`

Use the new members/link-sharing/invite-token endpoints above.

## 6. Suggested Frontend UX Wiring
- Board Share dialog:
  - Section A: link sharing (toggle + permission + rotate)
  - Section B: invite by email (`permission`)
  - Section C: direct member list + permission edits/removal
- Board open flow:
  - If URL has share token, call `GET /shared/:token` then route to `/board/:id?shareToken=...`
  - Pass `shareToken` to board read/write/presence calls.
- Pending invites UI:
  - Use `GET /sharing/pending-invites`
  - Accept via `POST /boards/invites/:token/accept`

## 7. Quick Verification
After frontend wiring:
1. As owner/admin, enable link sharing with `edit`, open link in logged-out session, verify edit works.
2. Rotate token, verify old link fails and new link works.
3. Invite external user to board with `view`, accept via token endpoint, verify access.
4. Workspace `viewer` can view but cannot edit unless added to `board_members` with `edit`.
