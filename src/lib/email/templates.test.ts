import { describe, expect, it } from "vitest";

import { describeLead, formatDeadline, reminderEmail } from "./templates";

const DEADLINE = new Date("2026-08-07T01:00:00.000Z");

const INPUT = {
  title: "Ship the migration",
  deadlineAt: DEADLINE,
  timeZone: "Asia/Manila",
  url: "https://devtask.example/tasks",
  leadMinutes: 30,
};

describe("formatDeadline renders in the recipient's zone", () => {
  /**
   * The whole point, and the thing that would be silently wrong forever if it
   * broke: 01:00 UTC is 09:00 the same morning in Manila. A job running in UTC
   * that formatted with the ambient zone would tell a Manila user their 09:00
   * task is due at 01:00 — and unlike a page, nobody is watching to notice.
   */
  it("shows the local wall clock, not the server's", () => {
    expect(formatDeadline(DEADLINE, "Asia/Manila")).toBe("7 Aug 2026 at 09:00");
    expect(formatDeadline(DEADLINE, "UTC")).toBe("7 Aug 2026 at 01:00");
  });

  it("moves the date too when the zone crosses midnight", () => {
    // Still 6 August in New York while it is already the 7th in Manila.
    expect(formatDeadline(DEADLINE, "America/New_York")).toBe(
      "6 Aug 2026 at 21:00",
    );
  });

  it("uses a 24-hour clock, so 13:00 is never 1:00", () => {
    expect(formatDeadline(new Date("2026-08-07T13:00:00.000Z"), "UTC")).toBe(
      "7 Aug 2026 at 13:00",
    );
  });

  it("pins the locale, so the same reminder reads the same from any host", () => {
    // Day-first and unambiguous. A host-dependent format would make "7 Aug" and
    // "Aug 7" depend on which machine sent the mail.
    expect(formatDeadline(DEADLINE, "UTC")).toMatch(/^\d+ \w{3} \d{4} at /);
  });
});

describe("describeLead", () => {
  it.each([
    [15, "in 15 minutes"],
    [30, "in 30 minutes"],
    [60, "in 1 hour"],
    [120, "in 2 hours"],
    [1440, "in 1 day"],
    [2880, "in 2 days"],
  ])("renders %i minutes as %s", (minutes, expected) => {
    expect(describeLead(minutes)).toBe(expected);
  });

  it("says 'now' at a zero lead, rather than 'in 0 minutes'", () => {
    expect(describeLead(0)).toBe("now");
  });

  it("keeps a lead no preset offers in minutes rather than rounding it", () => {
    // 90 is an hour and a half; "in 1 hour" would be a lie and "in 1.5 hours"
    // is not something to invent. The literal number is honest.
    expect(describeLead(90)).toBe("in 90 minutes");
  });
});

describe("reminderEmail", () => {
  it("leads the subject with the title, because that is what a list shows", () => {
    expect(reminderEmail(INPUT).subject).toBe(
      "Ship the migration — due in 30 minutes",
    );
  });

  it("puts the local deadline and the link in both parts", () => {
    const message = reminderEmail(INPUT);

    for (const part of [message.text, message.html]) {
      expect(part).toContain("Ship the migration");
      expect(part).toContain("7 Aug 2026 at 09:00");
      expect(part).toContain("https://devtask.example/tasks");
    }
  });

  it("escapes a title that would otherwise be markup", () => {
    // Only this account holder ever receives their own reminder, so nobody else
    // is at risk — but a title reading `<b>urgent</b>` should say so rather than
    // turn the rest of the message bold.
    const message = reminderEmail({ ...INPUT, title: "<b>urgent</b> & <i>late</i>" });

    expect(message.html).toContain("&lt;b&gt;urgent&lt;/b&gt; &amp; &lt;i&gt;late&lt;/i&gt;");
    expect(message.html).not.toContain("<b>urgent</b>");
    // The text part is not markup and must not be mangled.
    expect(message.text).toContain("<b>urgent</b> & <i>late</i>");
  });

  it("carries no image, table, or web font", () => {
    // Mail clients are the one place a layout genuinely arrives broken. The HTML
    // is a legible fallback of the text, not a different message.
    const { html } = reminderEmail(INPUT);

    expect(html).not.toMatch(/<img|<table|@font-face|<style/i);
  });
});
