import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * CRITERIA 8 AND 9, AS A SOURCE-LEVEL ASSERTION.
 *
 *   8. No admin route, procedure, or component imports anything from
 *      `src/lib/db/repos/occurrences.ts`, and no admin query names a task table.
 *      *Greppable, and asserted.*
 *   9. `dbAdmin` appears only in the admin account-operation path and the
 *      existing bootstrap script — nowhere else this phase adds.
 *
 * ## Why a grep is a legitimate test here
 *
 * Every other guarantee in this project is enforced by something that cannot be
 * forgotten: RLS refuses the rows, `adminProcedure` refuses the caller, the
 * transition table refuses the move. This one cannot be. "The admin tier must
 * never read task data — not even a count" is a rule about what somebody might
 * *add*, and the thing that would break it is one plausible-looking import in a
 * file that currently has none. `tests/integration/rls-boundary.test.ts` proves
 * the database still refuses an admin's own session; it cannot prove that a
 * future admin screen did not reach for `dbAdmin` and join to a task table,
 * because `dbAdmin` bypasses the policies that would otherwise object.
 *
 * So this asserts the shape of the code, which is exactly the level the rule is
 * written at. It fails loudly the moment somebody adds the "3 open tasks" column
 * that `AGENTS.md` and `src/lib/db/client.ts` both warn about by name.
 *
 * ## Comments are stripped first
 *
 * Several of these files talk *about* task tables at length — that is the point
 * of their doc comments, and the banner in `repos/profiles.ts` names
 * `task_occurrence` precisely so a reader knows what must never appear below it.
 * Asserting over raw text would make the warning fail the test that enforces it.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "..");
const ROOT = join(SRC, "..");

/** Every file the admin tier is made of. */
const ADMIN_TREES = [
  join(SRC, "app", "(admin)"),
  join(SRC, "components", "admin"),
  join(SRC, "lib", "admin"),
];

const ADMIN_FILES = [
  join(SRC, "lib", "trpc", "routers", "admin.ts"),
  join(SRC, "lib", "supabase", "admin.ts"),
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Strip comments so the assertions are about code rather than prose.
 *
 * Block comments go first, then line comments — the `(^|[^:])` guard keeps a
 * `//` that is part of a `http://` URL from truncating the rest of a real line.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function adminSources(): { path: string; code: string }[] {
  const paths = [
    ...ADMIN_TREES.flatMap(walk),
    ...ADMIN_FILES,
  ].filter((path) => /\.tsx?$/.test(path));

  return paths.map((path) => ({
    path: relative(ROOT, path),
    code: stripComments(readFileSync(path, "utf8")),
  }));
}

/** Exclude this file — it necessarily names everything it forbids. */
const SOURCES = adminSources().filter(
  (file) => !file.path.endsWith("isolation.test.ts"),
);

describe("the admin tier is made of the files we think it is", () => {
  it("finds the router, the shell, the list and the pure modules", () => {
    const paths = SOURCES.map((file) => file.path);

    // A guard on the guard: if a rename made `walk` return nothing, every
    // assertion below would pass vacuously.
    expect(paths.length).toBeGreaterThanOrEqual(10);
    for (const expected of [
      "src/lib/trpc/routers/admin.ts",
      "src/lib/supabase/admin.ts",
      "src/lib/admin/transitions.ts",
      "src/components/admin/account-list.tsx",
      "src/components/admin/admin-shell.tsx",
      "src/app/(admin)/layout.tsx",
      "src/app/(admin)/admin/users/page.tsx",
    ]) {
      expect(paths).toContain(expected);
    }
  });
});

describe("criterion 8 — no admin file can reach task data", () => {
  /** The modules that would hand it over. */
  const FORBIDDEN_IMPORTS = [
    "@/lib/db/repos/occurrences",
    "@/lib/tasks",
    "@/components/tasks",
    "repos/occurrences",
  ];

  it.each(FORBIDDEN_IMPORTS)("nothing imports %s", (specifier) => {
    for (const file of SOURCES) {
      expect(file.code, `${file.path} imports ${specifier}`).not.toContain(
        specifier,
      );
    }
  });

  /**
   * The table, by either of its names. `taskOccurrence` is the Drizzle mirror
   * and `task_occurrence` is the relation — a query naming either is a query
   * this tier must not be composing.
   */
  it.each(["taskOccurrence", "task_occurrence"])(
    "no admin file names %s in code",
    (identifier) => {
      for (const file of SOURCES) {
        expect(file.code, `${file.path} names ${identifier}`).not.toContain(
          identifier,
        );
      }
    },
  );

  /**
   * And the escalation itself. The admin *router* delegates to the repo; if it
   * ever imports `dbAdmin` directly it has stepped around the one fenced,
   * labelled place where such statements are reviewed.
   */
  it("the admin router does not import dbAdmin", () => {
    const router = SOURCES.find(
      (file) => file.path === "src/lib/trpc/routers/admin.ts",
    )!;

    expect(router.code).not.toContain("dbAdmin");
    expect(router.code).toContain("@/lib/db/repos/profiles");
  });
});

describe("criterion 9 — dbAdmin appears only where it is sanctioned", () => {
  /**
   * The whole list, and each entry's reason. `AGENTS.md` names three legitimate
   * callers — the reminder job (phase 6), admin account operations on
   * `profiles`, and migrations plus `scripts/create-admin.ts`. Phase 5 adds
   * exactly one of them.
   */
  const SANCTIONED_IMPORTERS = new Set([
    // Borrows it and immediately demotes the connection to `authenticated`,
    // which is how every user-facing read in the app reaches Postgres.
    "src/lib/db/rls.ts",
    // The phase-5 carve-out: admin account operations, fenced and labelled.
    "src/lib/db/repos/profiles.ts",
    // Their own tests.
    "src/lib/db/repos/profiles.test.ts",
    "tests/integration/rls-boundary.test.ts",
    // Phase 3's series suite, on the same sanction as the boundary spec above:
    // it writes through `withUser()` and reads back with `dbAdmin` to prove the
    // write landed where the policy says it should. Seeding privileged is the
    // point — fixtures created through `withUser()` would prove only the insert
    // policy, and if that policy were broken they would silently fail to exist
    // and every assertion after them would pass against an empty table.
    "tests/integration/series.test.ts",
    // Phase 6's reminder suite, on that same sanction and for one more reason of
    // its own. Its central assertion is that running the job leaves
    // `task_occurrence` **byte-identical** — which can only be checked by
    // reading the table with a connection the job's own policies do not filter.
    // A scoped read would show one user's rows and could not tell "the job wrote
    // nothing" apart from "the job wrote something I cannot see". It also has to
    // set `profiles.status` to `active`, which the 0003 escalation guard refuses
    // through a session by design.
    //
    // Note what did NOT need adding: no file under `src/**`. The job escalates
    // only through `profiles.listActiveRecipientsAsAdmin`, inside the fence that
    // already existed, and reads every task through `withUser()`.
    "tests/integration/reminders.test.ts",
  ]);

  /**
   * `scripts/create-admin.ts` — the third sanctioned caller in `AGENTS.md` —
   * deliberately does not appear: it goes through the Supabase admin API rather
   * than a direct connection, so it never imports this symbol at all.
   */
  const DEFINER = "src/lib/db/client.ts";

  function sourcesUnder(dir: string): string[] {
    return walk(dir).filter((path) => /\.tsx?$/.test(path));
  }

  /**
   * This spec is excluded from its own sweep. It necessarily contains both the
   * symbol and the patterns that match it, so leaving it in would make the file
   * flag itself.
   */
  const ALL_SOURCES = [
    ...sourcesUnder(SRC),
    ...sourcesUnder(join(ROOT, "tests")),
  ]
    .map((path) => ({
      path: relative(ROOT, path),
      code: stripComments(readFileSync(path, "utf8")),
    }))
    .filter((file) => file.path !== "src/lib/admin/isolation.test.ts");

  it("is defined in exactly one file", () => {
    const definers = ALL_SOURCES.filter((file) =>
      /export const dbAdmin\b/.test(file.code),
    ).map((file) => file.path);

    expect(definers).toEqual([DEFINER]);
  });

  it("is imported by exactly the sanctioned files", () => {
    const importers = ALL_SOURCES.filter((file) =>
      /import\s*\{[^}]*\bdbAdmin\b[^}]*\}/.test(file.code),
    ).map((file) => file.path);

    expect(new Set(importers)).toEqual(SANCTIONED_IMPORTERS);
  });

  it("no admin-tier file imports it", () => {
    for (const file of SOURCES) {
      expect(
        /import\s*\{[^}]*\bdbAdmin\b[^}]*\}/.test(file.code),
        `${file.path} imports dbAdmin`,
      ).toBe(false);
    }
  });
});

describe("the escalated section of the profiles repo stays inside its fence", () => {
  const repo = stripComments(
    readFileSync(join(SRC, "lib", "db", "repos", "profiles.ts"), "utf8"),
  );

  /**
   * The banner in that file states the law in one line: *every statement below
   * may name `profiles` and `auth.users`, and nothing else.* This is the
   * mechanical half of it.
   */
  it("names no table but profiles and auth.users", () => {
    for (const identifier of [
      "taskOccurrence",
      "task_occurrence",
      "task_series",
      "occurrences",
    ]) {
      expect(repo, `repos/profiles.ts names ${identifier}`).not.toContain(
        identifier,
      );
    }
  });

  it("still marks every escalated function as such", () => {
    // A `dbAdmin` call inside a function whose name does not say `AsAdmin`
    // is the review signal going missing.
    const exported = [...repo.matchAll(/export async function (\w+)/g)].map(
      (match) => match[1],
    );

    expect(exported).toContain("findOwn");
    expect(exported).toContain("updateOwn");
    for (const name of exported) {
      const isScoped = name === "findOwn" || name === "updateOwn";
      expect(
        isScoped || name.endsWith("AsAdmin"),
        `${name} neither goes through withUser() nor is named …AsAdmin`,
      ).toBe(true);
    }
  });
});
