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
