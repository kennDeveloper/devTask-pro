import { defineConfig } from "drizzle-kit";

// NOTE: `out` points at supabase/migrations, but drizzle-kit generation is NOT
// the source of truth for this project's DDL. The numbered SQL files in
// supabase/migrations/ are hand-written and reviewed, because drizzle-kit
// cannot express the `security definer` auth.users trigger or the RLS
// policies — the parts most worth reading. `src/lib/db/schema.ts` is the typed
// mirror of that SQL. Use `db:generate` only to diff-check, never to author.
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./supabase/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
