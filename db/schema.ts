import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    category: text('category').notNull(),
    brand: text('brand').notNull(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    price: integer('price').notNull(),
    specs: text('specs').notNull(),
    demo: integer('demo').notNull().default(1),
  },
  (t) => [index('idx_products_category_price').on(t.category, t.price)],
);
export const prebuilts = sqliteTable('prebuilts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  brand: text('brand').notNull(),
  color: text('color').notNull(),
  price: integer('price').notNull(),
  partIds: text('part_ids').notNull(),
  demo: integer('demo').notNull().default(1),
});
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  requirements: text('requirements').notNull(),
  plans: text('plans').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
export const metadata = sqliteTable('metadata', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
export const conversations=sqliteTable('conversations',{
  id:text('id').primaryKey(),draft:text('draft').notNull(),messages:text('messages').notNull(),currentTaskId:text('current_task_id'),updatedAt:integer('updated_at').notNull(),
});
export const tasks=sqliteTable('tasks',{
 id:text('id').primaryKey(),sessionId:text('session_id').notNull(),name:text('name').notNull(),draft:text('draft').notNull(),result:text('result'),issues:text('issues').notNull(),version:integer('version').notNull(),updatedAt:integer('updated_at').notNull(),
});
