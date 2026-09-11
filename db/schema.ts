import {
  mysqlTable,
  varchar,
  text,
  longtext,
  int,
  bigint,
  index,
  uniqueIndex,
} from 'drizzle-orm/mysql-core';
export const products = mysqlTable(
  'products',
  {
    id: varchar('id', { length: 191 }).primaryKey(),
    category: varchar('category', { length: 32 }).notNull(),
    brand: varchar('brand', { length: 191 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    color: varchar('color', { length: 32 }).notNull(),
    price: int('price').notNull(),
    specs: text('specs').notNull(),
    demo: int('demo').notNull().default(1),
  },
  (t) => [index('idx_products_category_price').on(t.category, t.price)],
);
export const prebuilts = mysqlTable('prebuilts', {
  id: varchar('id', { length: 191 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  brand: varchar('brand', { length: 191 }).notNull(),
  color: varchar('color', { length: 32 }).notNull(),
  price: int('price').notNull(),
  partIds: text('part_ids').notNull(),
  demo: int('demo').notNull().default(1),
});
export const metadata = mysqlTable('metadata', {
  key: varchar('key', { length: 191 }).primaryKey(),
  value: text('value').notNull(),
});
export const conversations = mysqlTable('conversations', {
  id: varchar('id', { length: 191 }).primaryKey(),
  draft: longtext('draft').notNull(),
  messages: longtext('messages').notNull(),
  currentTaskId: varchar('current_task_id', { length: 191 }),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});
export const tasks = mysqlTable('tasks', {
  id: varchar('id', { length: 191 }).primaryKey(),
  sessionId: varchar('session_id', { length: 191 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  draft: longtext('draft').notNull(),
  result: longtext('result'),
  issues: longtext('issues').notNull(),
  version: int('version').notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});
export const taskHistory = mysqlTable(
  'task_history',
  {
    id: varchar('id', { length: 191 }).primaryKey(),
    taskId: varchar('task_id', { length: 191 })
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    operationId: varchar('operation_id', { length: 191 }).notNull(),
    sourceVersion: int('source_version').notNull(),
    snapshot: longtext('snapshot').notNull(),
  },
  (t) => [
    uniqueIndex('idx_task_history_operation').on(t.taskId, t.operationId),
    index('idx_task_history_version').on(t.taskId, t.sourceVersion),
  ],
);
