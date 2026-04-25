import { sql } from 'drizzle-orm'
import { boolean, check, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { boards } from './boards.js'
import { users } from './users.js'

export const journalNotes = pgTable('journal_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  journalId: uuid('journal_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  bodyJson: jsonb('body_json').notNull(),
  bodyText: text('body_text').notNull().default(''),
  excerpt: text('excerpt').notNull().default(''),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  color: text('color'),
  colorTitle: boolean('color_title').notNull().default(false),
  status: text('status').notNull().default('active'),
  pinned: boolean('pinned').notNull().default(false),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
  archivedAt: timestamp('archived_at', { withTimezone: true }),
}, (table) => [
  index('idx_journal_notes_journal_status_updated').on(table.journalId, table.status, table.updatedAt),
  index('idx_journal_notes_journal_pinned_updated').on(table.journalId, table.pinned, table.updatedAt),
  index('idx_journal_notes_tags_gin').using('gin', table.tags),
  check('valid_journal_note_status', sql`${table.status} IN ('active', 'archived')`),
])

export const journalNoteCanvasLinks = pgTable('journal_note_canvas_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  noteId: uuid('note_id').notNull().references(() => journalNotes.id, { onDelete: 'cascade' }),
  canvasBoardId: uuid('canvas_board_id').notNull().references(() => boards.id, { onDelete: 'cascade' }),
  targetElementId: text('target_element_id'),
  targetContainerId: text('target_container_id'),
  syncMode: text('sync_mode').notNull().default('synced'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow(),
}, (table) => [
  index('idx_journal_note_canvas_links_note').on(table.noteId),
  index('idx_journal_note_canvas_links_canvas').on(table.canvasBoardId),
  check('valid_journal_note_canvas_sync_mode', sql`${table.syncMode} IN ('synced', 'snapshot', 'plain_text')`),
])
