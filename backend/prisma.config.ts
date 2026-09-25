import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // `prisma generate` doesn't connect, so a missing URL must not break it (CI, postinstall);
  // commands that do connect (migrate, db push) fail with a clear connection error instead.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
