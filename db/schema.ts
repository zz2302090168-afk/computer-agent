import { mysqlTable, varchar, text, int, index } from 'drizzle-orm/mysql-core';
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
// 显示器是主机配置完成后独立推荐的外设，不混入八类 DIY 配件。
export const monitors = mysqlTable(
  'monitors',
  {
    id: varchar('id', { length: 191 }).primaryKey(),
    brand: varchar('brand', { length: 191 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    price: int('price').notNull(),
    specs: text('specs').notNull(),
    demo: int('demo').notNull().default(1),
  },
  (t) => [index('idx_monitors_price').on(t.price)],
);
export const metadata = mysqlTable('metadata', {
  key: varchar('key', { length: 191 }).primaryKey(),
  value: text('value').notNull(),
});
