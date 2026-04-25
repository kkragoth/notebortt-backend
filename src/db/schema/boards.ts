import { sql } from 'drizzle-orm'
import { bigint, boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'
import { workspaces } from './workspaces.js'

export const boards = pgTable('boards', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  itemType: text('item_type').notNull().default('canvas'),
  status: text('status').notNull().default('active'),
  avatarShortcut: text('avatar_shortcut'),
  avatarColor: text('avatar_color'),
  sidebarOrder: integer('sidebar_order').notNull().default(0),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
  currentCommitId: uuid('current_commit_id').references((): any => commits.id, { onDelete: 'set null' }),
  currentBranch: text('current_branch').default('main'),
  previewSvg: text('preview_svg'),
  previewVersion: text('preview_version'),
  previewUpdatedAt: timestamp('preview_updated_at', { withTimezone: true }),
  linkShareEnabled: boolean('link_share_enabled').notNull().default(false),
  linkShareToken: text('link_share_token').unique(),
  linkSharePermission: text('link_share_permission').notNull().default('view'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_boards_workspace').on(table.workspaceId),
  index('idx_boards_workspace_status_sidebar_order').on(table.workspaceId, table.status, table.sidebarOrder),
  index('idx_boards_workspace_item_type_sidebar_order').on(table.workspaceId, table.itemType, table.sidebarOrder),
  index('idx_boards_link_token').on(table.linkShareToken),
  check('valid_item_type', sql`${table.itemType} IN ('canvas', 'journal', 'graph')`),
  check('valid_item_status', sql`${table.status} IN ('active', 'archived')`),
  check('valid_avatar_shortcut_length', sql`${table.avatarShortcut} IS NULL OR length(${table.avatarShortcut}) <= 4`),
  check('valid_link_share_permission', sql`${table.linkSharePermission} IN ('view', 'edit')`),
  check('link_share_token_required_when_enabled', sql`NOT ${table.linkShareEnabled} OR ${table.linkShareToken} IS NOT NULL`),
])

export const boardMembers = pgTable('board_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull().default('view'),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('board_member_user_idx').on(table.boardId, table.userId),
  index('idx_board_members_user').on(table.userId),
  check('valid_board_member_permission', sql`${table.permission} IN ('view', 'edit')`),
])

export const boardFavorites = pgTable('board_favorites', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('board_favorite_user_idx').on(table.boardId, table.userId),
  index('idx_board_favorites_user').on(table.userId),
])

export const boardInvitations = pgTable('board_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  invitedBy: uuid('invited_by').notNull().references(() => users.id, { onDelete: 'cascade' }),
  emailLower: text('email_lower').notNull(),
  permission: text('permission').notNull().default('view'),
  status: text('status').notNull().default('pending'),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_board_invitations_email').on(table.emailLower),
  uniqueIndex('board_invitation_pending_idx').on(table.boardId, table.emailLower, table.status),
  check('valid_board_invitation_permission', sql`${table.permission} IN ('view', 'edit')`),
  check('valid_board_invitation_status', sql`${table.status} IN ('pending', 'accepted', 'revoked', 'expired')`),
])

export const elements = pgTable('elements', {
  id: text('id').primaryKey(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_elements_board').on(table.boardId),
  check('valid_element_type', sql`${table.type} IN ('NOTE','TEXT','ARROW','DRAWING','SHAPE','COLUMN','TABLE','IMAGE','LINK_PREVIEW','META_COLUMN')`),
])

export const mutations = pgTable('mutations', {
  id: text('id').primaryKey(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  sequence: bigint('sequence', { mode: 'number' }).notNull(),
  operationType: text('operation_type').notNull(),
  operationData: jsonb('operation_data').notNull(),
  clientTs: timestamp('client_ts', { withTimezone: true }).notNull(),
  serverTs: timestamp('server_ts', { withTimezone: true }).defaultNow(),
  userId: uuid('user_id').references(() => users.id),
  sessionId: text('session_id'),
}, (table) => [
  uniqueIndex('mutation_board_seq_idx').on(table.boardId, table.sequence),
  check('valid_operation_type', sql`${table.operationType} IN ('CREATE_ELEMENT','UPDATE_ELEMENT','DELETE_ELEMENTS','MOVE_ELEMENTS','UPDATE_ELEMENTS','REORDER_ELEMENT')`),
])

export const commits = pgTable('commits', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  parentId: uuid('parent_id').references((): any => commits.id),
  branchName: text('branch_name').notNull().default('main'),
  message: text('message').notNull(),
  snapshot: jsonb('snapshot').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_commits_board_branch').on(table.boardId, table.branchName),
])
