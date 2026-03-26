import { pgTable, uuid, text, timestamp, bigint, jsonb, uniqueIndex, index, check } from 'drizzle-orm/pg-core'
import { sql } from 'drizzle-orm'

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const oauthAccounts = pgTable('oauth_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  providerId: text('provider_id').notNull(),
  email: text('email').notNull(),
}, (table) => [
  uniqueIndex('oauth_provider_id_idx').on(table.provider, table.providerId),
])

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
})

export const workspaceMembers = pgTable('workspace_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('workspace_member_idx').on(table.workspaceId, table.userId),
  check('valid_workspace_role', sql`${table.role} IN ('owner', 'admin', 'member')`),
])

export const workspaceInvitations = pgTable('workspace_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  invitedBy: uuid('invited_by').notNull().references(() => users.id),
  email: text('email').notNull(),
  role: text('role').notNull().default('member'),
  status: text('status').notNull().default('pending'),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('invitation_unique_idx').on(table.workspaceId, table.email, table.status),
  check('valid_invite_role', sql`${table.role} IN ('admin', 'member')`),
  check('valid_invite_status', sql`${table.status} IN ('pending', 'accepted', 'declined', 'expired')`),
])

export const boards = pgTable('boards', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  currentCommitId: uuid('current_commit_id'),
  currentBranch: text('current_branch').default('main'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const boardShares = pgTable('board_shares', {
  id: uuid('id').primaryKey().defaultRandom(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
  permission: text('permission').notNull().default('view'),
  token: text('token').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('board_share_user_idx').on(table.boardId, table.userId),
  check('valid_share_permission', sql`${table.permission} IN ('view', 'edit')`),
])

export const elements = pgTable('elements', {
  id: text('id').primaryKey(),
  boardId: uuid('board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  type: text('type').notNull(),
  data: jsonb('data').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_elements_board').on(table.boardId),
  check('valid_element_type', sql`${table.type} IN ('NOTE','TEXT','ARROW','DRAWING','SHAPE','COLUMN','IMAGE','LINK_PREVIEW')`),
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
