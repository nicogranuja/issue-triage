import { defineConfig } from 'drizzle-kit';

// Used only by `npm run db:generate` to turn schema changes into a new SQL migration.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
});
