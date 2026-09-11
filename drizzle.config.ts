import { defineConfig } from 'drizzle-kit';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local', quiet: true });

export default defineConfig({
  out: './drizzle-mysql',
  schema: './db/schema.ts',
  dialect: 'mysql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
});
