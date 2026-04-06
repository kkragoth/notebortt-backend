export const BOARD_PERMISSION_VIEW = 'view'
export const BOARD_PERMISSION_EDIT = 'edit'
export const BOARD_ROLE_EDITOR = 'editor'
export const BOARD_ROLE_VIEWER = 'viewer'

export const INVITATION_STATUS_PENDING = 'pending'
export const INVITATION_STATUS_ACCEPTED = 'accepted'
export const INVITATION_STATUS_REVOKED = 'revoked'

export type BoardPermission = typeof BOARD_PERMISSION_VIEW | typeof BOARD_PERMISSION_EDIT
export type BoardInviteRole = typeof BOARD_ROLE_EDITOR | typeof BOARD_ROLE_VIEWER
