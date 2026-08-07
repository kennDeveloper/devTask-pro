import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as profilesRepo from "@/lib/db/repos/profiles";
import * as remindersRepo from "@/lib/db/repos/reminders";
import { sendEmail } from "@/lib/email/send";
import * as feed from "@/lib/tasks/feed";

import { runReminders } from "./run";

import type { ListedOccurrence } from "@/lib/tasks/feed";

/**
 * Unit tests for the run. **No database and no mail server are touched.**
 *
 * The repos, the feed and the transport are all mocked, so what these assert is
 * the orchestration: that the claim precedes the send, that a failure is
 * contained, and — most importantly — that the run reads through the scoped path
 * with each account's own claims rather than escalating.
 *
 * The live proof is `tests/integration/reminders.test.ts`.
 */

vi.mock("@/lib/db/repos/profiles", () => ({
  listActiveRecipientsAsAdmin: vi.fn(),
}));
vi.mock("@/lib/db/repos/reminders", async (importOriginal) => {
  // `reminderKeyToken` is pure and the run uses it for real — mocking it would
  // make the dedupe assertions meaningless.
  const actual = await importOriginal<typeof remindersRepo>();
  return { ...actual, claim: vi.fn(), listSentKeys: vi.fn() };
});
vi.mock("@/lib/email/send", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/tasks/feed", async (importOriginal) => {
  const actual = await importOriginal<typeof feed>();
  return { ...actual, listAllFeed: vi.fn() };
});

const NOW = new Date("2026-08-07T08:30:00.000Z");
const DEADLINE = new Date("2026-08-07T09:00:00.000Z");
const EPOCH = new Date("2026-01-01T00:00:00.000Z");

const ALICE = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "alice@example.com",
  timezone: "Asia/Manila",
};
const BOB = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "bob@example.com",
  timezone: "UTC",
};

function due(overrides: Partial<ListedOccurrence> = {}): ListedOccurrence {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    seriesId: null,
    title: "Ship the migration",
    description: null,
    occursOn: "2026-08-07",
    deadlineAt: DEADLINE,
    status: "todo",
    progressPct: 0,
    reminderLeadMinutes: 30,
    completedAt: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
    virtual: false,
    tags: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(profilesRepo.listActiveRecipientsAsAdmin).mockResolvedValue([ALICE]);
  vi.mocked(remindersRepo.listSentKeys).mockResolvedValue([]);
  vi.mocked(remindersRepo.claim).mockResolvedValue(true);
  vi.mocked(feed.listAllFeed).mockResolvedValue([due()]);
  vi.mocked(sendEmail).mockResolvedValue(undefined);
});

describe("the run stays inside row level security", () => {
  it("reads each account's tasks with that account's own claims", async () => {
    // The load-bearing assertion of the whole phase. If this ever becomes a
    // privileged scan, criterion 12 is gone and nothing else here would notice.
    await runReminders(NOW);

    expect(feed.listAllFeed).toHaveBeenCalledTimes(1);
    expect(vi.mocked(feed.listAllFeed).mock.calls[0][0]).toEqual({
      sub: ALICE.id,
      email: ALICE.email,
    });
  });

  it("resolves each account's today in that account's own zone", async () => {
    // 08:30 UTC on the 7th is already 16:30 on the 7th in Manila — same day
    // here, but the point is that the zone consulted is the profile's.
    vi.mocked(profilesRepo.listActiveRecipientsAsAdmin).mockResolvedValue([
      { ...ALICE, timezone: "Pacific/Kiritimati" },
    ]);

    await runReminders(NOW);

    // UTC+14: 08:30 on the 7th is 22:30 on the 7th — but an instant before
    // 10:00 UTC would be the 8th there, which is the class of bug this guards.
    const [, today, zone] = vi.mocked(feed.listAllFeed).mock.calls[0];
    expect(zone).toBe("Pacific/Kiritimati");
    expect(today).toBe("2026-08-07");
  });

  it("escalates exactly once, to enumerate accounts", async () => {
    await runReminders(NOW);

    expect(profilesRepo.listActiveRecipientsAsAdmin).toHaveBeenCalledTimes(1);
  });

  it("never imports the RLS-bypassing connection", () => {
    // The source-level guard the repos carry, applied to the one module that
    // would most plausibly reach for it: a job with no session.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "run.ts"), "utf8");

    const imports = source.match(/^import[\s\S]*?from\s+["'][^"']+["'];/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.join("\n")).not.toMatch(/dbAdmin|db\/client/);
  });

  it("writes nothing to task_occurrence — it does not even import the repo", () => {
    // Criteria 15 and 17 hold because untouched occurrences are never rows. The
    // run has no way to make one: it imports no occurrence repo at all.
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, "run.ts"), "utf8");

    const imports = source.match(/^import[\s\S]*?from\s+["'][^"']+["'];/gm) ?? [];
    expect(imports.join("\n")).not.toMatch(/repos\/occurrences|repos\/series/);
  });
});

describe("claim then send", () => {
  it("claims before sending", async () => {
    const order: string[] = [];
    vi.mocked(remindersRepo.claim).mockImplementation(async () => {
      order.push("claim");
      return true;
    });
    vi.mocked(sendEmail).mockImplementation(async () => {
      order.push("send");
    });

    await runReminders(NOW);

    expect(order).toEqual(["claim", "send"]);
  });

  it("sends nothing when the claim was lost to another run", async () => {
    vi.mocked(remindersRepo.claim).mockResolvedValue(false);

    const summary = await runReminders(NOW);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(summary.claimed).toBe(0);
    expect(summary.sent).toBe(0);
    // Still a candidate — it was due, somebody else just got there first.
    expect(summary.candidates).toBe(1);
  });

  it("records the deadline it counted back from on the ledger", async () => {
    await runReminders(NOW);

    expect(vi.mocked(remindersRepo.claim).mock.calls[0][1]).toEqual({
      key: {
        kind: "occurrence",
        occurrenceId: "33333333-3333-4333-8333-333333333333",
        occursOn: "2026-08-07",
      },
      deadlineAt: DEADLINE,
    });
  });
});

describe("a failure is contained", () => {
  it("counts a failed send and does not retry it", async () => {
    vi.mocked(sendEmail).mockRejectedValue(new Error("smtp down"));

    const summary = await runReminders(NOW);

    expect(summary.claimed).toBe(1);
    expect(summary.sent).toBe(0);
    expect(summary.failed).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("keeps mailing everybody else after one send throws", async () => {
    vi.mocked(profilesRepo.listActiveRecipientsAsAdmin).mockResolvedValue([
      ALICE,
      BOB,
    ]);
    vi.mocked(sendEmail)
      .mockRejectedValueOnce(new Error("bad address"))
      .mockResolvedValue(undefined);

    const summary = await runReminders(NOW);

    expect(summary.recipients).toBe(2);
    expect(summary.sent).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("keeps going when a whole account's read throws", async () => {
    vi.mocked(profilesRepo.listActiveRecipientsAsAdmin).mockResolvedValue([
      ALICE,
      BOB,
    ]);
    vi.mocked(feed.listAllFeed)
      .mockRejectedValueOnce(new Error("connection lost"))
      .mockResolvedValue([due()]);

    const summary = await runReminders(NOW);

    expect(summary.failed).toBe(1);
    expect(summary.sent).toBe(1);
  });
});

describe("the summary", () => {
  it("counts nothing when there is nobody to mail", async () => {
    vi.mocked(profilesRepo.listActiveRecipientsAsAdmin).mockResolvedValue([]);

    await expect(runReminders(NOW)).resolves.toEqual({
      recipients: 0,
      candidates: 0,
      claimed: 0,
      sent: 0,
      failed: 0,
      skippedLate: 0,
    });
    expect(feed.listAllFeed).not.toHaveBeenCalled();
  });

  it("reports a reminder whose moment passed rather than sending it", async () => {
    const late = new Date(DEADLINE.getTime() + 60_000);

    const summary = await runReminders(late);

    expect(summary.skippedLate).toBe(1);
    expect(summary.sent).toBe(0);
    expect(remindersRepo.claim).not.toHaveBeenCalled();
  });

  it("adds up across accounts", async () => {
    vi.mocked(profilesRepo.listActiveRecipientsAsAdmin).mockResolvedValue([
      ALICE,
      BOB,
    ]);

    const summary = await runReminders(NOW);

    expect(summary).toEqual({
      recipients: 2,
      candidates: 2,
      claimed: 2,
      sent: 2,
      failed: 0,
      skippedLate: 0,
    });
  });
});

describe("the ledger is consulted before claiming", () => {
  it("skips a reminder already in it", async () => {
    vi.mocked(remindersRepo.listSentKeys).mockResolvedValue([
      {
        kind: "occurrence",
        occurrenceId: "33333333-3333-4333-8333-333333333333",
        occursOn: "2026-08-07",
      },
    ]);

    const summary = await runReminders(NOW);

    expect(remindersRepo.claim).not.toHaveBeenCalled();
    expect(summary.sent).toBe(0);
  });

  it("reads it a little wider than today, for an occurrence due tomorrow", async () => {
    // A task on the 7th can carry a deadline early on the 8th in a far-eastern
    // zone. Reading from today alone would attempt a claim that must fail.
    await runReminders(NOW);

    expect(vi.mocked(remindersRepo.listSentKeys).mock.calls[0][1]).toBe(
      "2026-08-05",
    );
  });
});

describe("the message", () => {
  it("addresses the account holder and renders in their zone", async () => {
    await runReminders(NOW);

    const message = vi.mocked(sendEmail).mock.calls[0][0];
    expect(message.to).toBe(ALICE.email);
    // 09:00 UTC is 17:00 in Manila.
    expect(message.text).toContain("7 Aug 2026 at 17:00");
    expect(message.subject).toContain("Ship the migration");
  });

  it("uses the series' lead for a projected occurrence", async () => {
    vi.mocked(feed.listAllFeed).mockResolvedValue([
      due({
        id: "series:44444444-4444-4444-8444-444444444444:2026-08-07",
        seriesId: "44444444-4444-4444-8444-444444444444",
        virtual: true,
        reminderLeadMinutes: 60,
        deadlineAt: DEADLINE,
      }),
    ]);
    // 60 minutes before 09:00 is 08:00, which has passed at 08:30.
    await runReminders(NOW);

    expect(vi.mocked(sendEmail).mock.calls[0][0].subject).toContain(
      "in 1 hour",
    );
  });
});
