import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { users } from './users.js'

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
})

export const workspaceMembers = pgTable('workspace_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('viewer'),
  addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('workspace_member_idx').on(table.workspaceId, table.userId),
  uniqueIndex('workspace_single_owner_idx').on(table.workspaceId).where(sql`${table.role} = 'owner'`),
  index('idx_workspace_members_user').on(table.userId),
  check('valid_workspace_role', sql`${table.role} IN ('owner', 'admin', 'editor', 'viewer')`),
])

export const workspaceInvitations = pgTable('workspace_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  workspaceId: uuid('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  invitedBy: uuid('invited_by').notNull().references(() => users.id),
  email: text('email').notNull(),
  emailLower: text('email_lower').notNull(),
  role: text('role').notNull().default('viewer'),
  status: text('status').notNull().default('pending'),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  respondedAt: timestamp('responded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  uniqueIndex('workspace_invitation_pending_idx').on(table.workspaceId, table.emailLower, table.status),
  check('valid_workspace_invite_role', sql`${table.role} IN ('admin', 'editor', 'viewer')`),
  check('valid_workspace_invite_status', sql`${table.status} IN ('pending', 'accepted', 'declined', 'expired', 'revoked')`),
])
