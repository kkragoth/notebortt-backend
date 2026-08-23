export const BOARD_PERMISSION_VIEW = 'view';
export const BOARD_PERMISSION_EDIT = 'edit';

export const INVITATION_STATUS_PENDING = 'pending';
export const INVITATION_STATUS_ACCEPTED = 'accepted';
export const INVITATION_STATUS_REVOKED = 'revoked';

export type BoardPermission = typeof BOARD_PERMISSION_VIEW | typeof BOARD_PERMISSION_EDIT
