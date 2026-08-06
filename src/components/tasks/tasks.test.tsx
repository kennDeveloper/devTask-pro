import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TaskListLayout, type TaskListQuery } from "./task-list";

import type { Task, TaskClock } from "./types";

/**
 * The task list, both presentations, against a stubbed tRPC client.
 *
 * ## Why the client is mocked rather than wrapped in a provider
 *
 * A real `TRPCProvider` would need a running `/api/trpc`, and the interesting
 * assertions here are about *what is sent*, not about the transport: that a
 * rename produces `{ id, title }` and nothing else, that a status change and a
 * progress change stay independent. Stubbing the hooks makes the payload
 * directly observable. The transport is proven by `src/lib/trpc/routers/task.test.ts`
 * and by `tests/integration/`.
 *
 * The stub is faithful in one respect that matters: `mutate` invokes both the
 * hook-level `onSuccess` (which invalidates) and the per-call one (which closes
 * the dialog), because those two paths are the ones the components rely on.
 */

interface MutationOptions {
  onSuccess?: () => void;
}

const api = vi.hoisted(() => {
  interface MutationStub {
    hookOptions?: { onSuccess?: () => void };
    mutate: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    isPending: boolean;
    isError: boolean;
    error: { message: string } | null;
  }

  function stub(): MutationStub {
    const mutation: MutationStub = {
      hookOptions: undefined,
      mutate: vi.fn(),
      reset: vi.fn(),
      isPending: false,
      isError: false,
      error: null,
    };
    mutation.mutate.mockImplementation(
      (_input: unknown, callOptions?: { onSuccess?: () => void }) => {
        mutation.hookOptions?.onSuccess?.();
        callOptions?.onSuccess?.();
      },
    );
    return mutation;
  }

  return {
    invalidate: vi.fn(),
    invalidateSeries: vi.fn(),
    create: stub(),
    update: stub(),
    remove: stub(),
    seriesCreate: stub(),
    seriesUpdate: stub(),
    seriesRemove: stub(),
    /** What `series.get` resolves to. `undefined` data is "still loading". */
    seriesGet: {
      data: undefined as unknown,
      error: null as { message: string } | null,
    },
  };
});

vi.mock("@/lib/trpc/client", () => {
  function bind(
    mutation: { hookOptions?: MutationOptions },
    options?: MutationOptions,
  ) {
    mutation.hookOptions = options;
    return mutation;
  }

  return {
    trpc: {
      useUtils: () => ({
        task: { invalidate: api.invalidate },
        series: { invalidate: api.invalidateSeries },
      }),
      task: {
        create: { useMutation: (o?: MutationOptions) => bind(api.create, o) },
        update: { useMutation: (o?: MutationOptions) => bind(api.update, o) },
        remove: { useMutation: (o?: MutationOptions) => bind(api.remove, o) },
      },
      series: {
        get: { useQuery: () => api.seriesGet },
        create: {
          useMutation: (o?: MutationOptions) => bind(api.seriesCreate, o),
        },
        update: {
          useMutation: (o?: MutationOptions) => bind(api.seriesUpdate, o),
        },
        remove: {
          useMutation: (o?: MutationOptions) => bind(api.seriesRemove, o),
        },
      },
    },
  };
});

// vitest.config.ts does not enable `globals`, so RTL's auto-cleanup never
// registers itself. Unmount explicitly or renders stack in one document.
afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  for (const mutation of [
    api.create,
    api.update,
    api.remove,
    api.seriesCreate,
    api.seriesUpdate,
    api.seriesRemove,
  ]) {
    mutation.isPending = false;
    mutation.isError = false;
    mutation.error = null;
  }
  api.seriesGet.data = undefined;
  api.seriesGet.error = null;
});

const CLOCK: TaskClock = {
  now: new Date("2026-08-06T15:00:00.000Z"),
  timeZone: "Asia/Manila",
  today: "2026-08-06",
};

const TASK_ID = "11111111-2222-4333-8444-555555555555";

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: TASK_ID,
    seriesId: null,
    virtual: false,
    title: "Write the migration",
    description: null,
    occursOn: "2026-08-06",
    deadlineAt: null,
    status: "todo",
    progressPct: 0,
    completedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function query(overrides: Partial<TaskListQuery> = {}): TaskListQuery {
  return {
    data: [task()],
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

function renderList(overrides: Partial<TaskListQuery> = {}) {
  const result = render(
    <TaskListLayout view="all" clock={CLOCK} query={query(overrides)} />,
  );

  const table = result.container.querySelector<HTMLElement>(
    '[data-slot="task-table"]',
  )!;
  const cards = result.container.querySelector<HTMLElement>(
    '[data-slot="task-cards"]',
  )!;

  return { ...result, table, cards };
}

describe("the two presentations", () => {
  /**
   * AGENTS.md: lists on mobile are cards, never tables. Asserted on the rendered
   * markup rather than by resizing a viewport, because jsdom has no layout and a
   * media query never evaluates — the classes ARE the behaviour here.
   */
  it("renders the table only from md up and the cards only below it", () => {
    const { table, cards } = renderList();

    expect(table).toHaveClass("hidden", "md:block");
    expect(cards).toHaveClass("md:hidden");

    // Each presentation holds its own kind of row, and neither leaks into the other.
    expect(within(table).getByRole("table")).toBeInTheDocument();
    expect(cards.querySelector("table")).toBeNull();
    expect(table.querySelector('[data-slot="task-card"]')).toBeNull();
    expect(cards.querySelector('[data-slot="task-card"]')).not.toBeNull();
  });

  it("gives both presentations a loading state that mirrors the real layout", () => {
    const { table, cards } = renderList({ data: undefined, isPending: true });

    expect(table.querySelectorAll('[data-slot="task-row-skeleton"]')).toHaveLength(6);
    expect(cards.querySelectorAll('[data-slot="task-card-skeleton"]')).toHaveLength(6);

    // The real header stays mounted throughout, so the columns do not move when
    // the rows resolve.
    expect(within(table).getByRole("columnheader", { name: "Task" })).toBeInTheDocument();
    expect(table.querySelector('[data-slot="task-row"]')).toBeNull();
  });

  it("gives both presentations an empty state, with one sentence between them", () => {
    const { table, cards } = renderList({ data: [] });

    expect(table.querySelector('[data-slot="task-table-empty"]')).not.toBeNull();
    expect(cards.querySelector('[data-slot="task-cards-empty"]')).not.toBeNull();

    // Same copy in both — the two presentations are one list, not two features.
    // Asserted by role: the title is a real heading, so a screen-reader user can
    // reach "why is this empty" by skimming instead of by reading through. In
    // jsdom no media query has been applied, so both copies are present.
    expect(
      screen.getAllByRole("heading", { name: "No tasks yet" }),
    ).toHaveLength(2);
  });

  it("replaces the list with an error rather than a skeleton that never resolves", async () => {
    const refetch = vi.fn();
    render(
      <TaskListLayout
        view="all"
        clock={CLOCK}
        query={query({ error: { message: "Network unreachable" }, refetch })}
      />,
    );

    expect(screen.getByText("Network unreachable")).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});

describe("what a row shows", () => {
  /**
   * Criterion 12. Progress is set by hand and means nothing about status, so a
   * finished task can sit at 40% and BOTH numbers have to survive on screen.
   * Nothing in this codebase coerces one from the other in either direction.
   */
  it("shows a done task at 40% as both done and 40%", () => {
    const { table, cards } = renderList({
      data: [task({ status: "done", progressPct: 40 })],
    });

    for (const presentation of [table, cards]) {
      const scope = within(presentation);
      expect(scope.getByLabelText("Status of Write the migration")).toHaveValue("done");
      expect(scope.getByLabelText("Progress of Write the migration")).toHaveValue("40");
      expect(scope.getByText("40%")).toBeInTheDocument();
    }
  });

  /**
   * Criterion 9. Late is a fact about the deadline, not a replacement for the
   * status — an overdue task still has to say whether it is `todo` or
   * `in_progress`, because that is what tells you how much work is left.
   */
  it("marks an overdue task without hiding what state it is in", () => {
    const { table, cards } = renderList({
      data: [
        task({
          status: "in_progress",
          // 14:00Z is an hour before the clock's 15:00Z.
          deadlineAt: "2026-08-06T14:00:00.000Z",
        }),
      ],
    });

    for (const presentation of [table, cards]) {
      const scope = within(presentation);
      expect(scope.getByText("Overdue")).toBeInTheDocument();
      expect(scope.getByLabelText("Status of Write the migration")).toHaveValue(
        "in_progress",
      );
      // Rendered in the account holder's zone: 14:00Z is 22:00 in Manila.
      expect(scope.getByText(/22:00/)).toBeInTheDocument();
    }

    expect(table.querySelector('[data-slot="task-row"]')).toHaveAttribute(
      "data-overdue",
      "true",
    );
  });

  it("does not call a task with no deadline overdue, however old it is", () => {
    const { table } = renderList({ data: [task({ occursOn: "2020-01-01" })] });

    expect(within(table).queryByText("Overdue")).toBeNull();
    expect(table.querySelector('[data-slot="task-row"]')).not.toHaveAttribute(
      "data-overdue",
    );
  });
});

describe("inline row controls", () => {
  it("sends only the status when the status control changes", async () => {
    const { table } = renderList();

    await userEvent.selectOptions(
      within(table).getByLabelText("Status of Write the migration"),
      "in_progress",
    );

    expect(api.update.mutate).toHaveBeenCalledTimes(1);
    expect(api.update.mutate).toHaveBeenCalledWith({
      id: TASK_ID,
      status: "in_progress",
    });
    // A patch can move a task between today, overdue and the full list, so the
    // whole router is invalidated rather than a guessed subset.
    expect(api.invalidate).toHaveBeenCalled();
  });

  it("sends the progress once per gesture, not once per pixel", () => {
    const { table } = renderList();
    const slider = within(table).getByLabelText("Progress of Write the migration");

    // A drag: React maps onChange on a range to the DOM `input` event, which
    // fires continuously. Only the release commits.
    fireEvent.change(slider, { target: { value: "20" } });
    fireEvent.change(slider, { target: { value: "40" } });
    expect(api.update.mutate).not.toHaveBeenCalled();

    fireEvent.keyUp(slider);
    expect(api.update.mutate).toHaveBeenCalledTimes(1);
    expect(api.update.mutate).toHaveBeenCalledWith({
      id: TASK_ID,
      progressPct: 40,
    });
  });

  it("shows a failed inline save in its own row, and leaves the controls usable", () => {
    api.update.isError = true;
    api.update.error = { message: "Task not found" };

    const { table, cards } = renderList();

    expect(within(table).getByRole("alert")).toHaveTextContent("Task not found");
    expect(within(cards).getByRole("alert")).toHaveTextContent("Task not found");
    // A failed write is not an in-flight one: the control has to stay live or
    // there is no way to try again.
    expect(
      within(table).getByLabelText("Status of Write the migration"),
    ).toBeEnabled();
    // The message gets a row of its own rather than being squeezed into a cell,
    // so it does not reflow the columns beside it.
    expect(table.querySelector('[data-slot="task-row-error"]')).not.toBeNull();
  });

  it("disables both controls while a save is in flight", () => {
    api.update.isPending = true;

    const { table } = renderList();
    const scope = within(table);

    expect(scope.getByLabelText("Status of Write the migration")).toBeDisabled();
    expect(scope.getByLabelText("Progress of Write the migration")).toBeDisabled();
  });
});

describe("the edit dialog", () => {
  async function openEditor(existing = task()) {
    const user = userEvent.setup();
    const view = renderList({ data: [existing] });

    await user.click(
      within(view.table).getByRole("button", { name: "Edit Write the migration" }),
    );

    return { user, ...view, dialog: screen.getByRole("dialog", { name: "Edit task" }) };
  }

  it("opens one dialog for the whole list, seeded from the row", async () => {
    const { dialog } = await openEditor(
      task({ description: "Add the grants", deadlineAt: "2026-08-06T15:00:00.000Z" }),
    );

    const scope = within(dialog);
    expect(scope.getByLabelText("Title")).toHaveValue("Write the migration");
    expect(scope.getByLabelText(/^Notes/)).toHaveValue("Add the grants");
    expect(scope.getByLabelText("Day")).toHaveValue("2026-08-06");
    // Seeded on the clock the user set it on — 15:00Z is 23:00 in Manila.
    expect(scope.getByLabelText(/^Deadline/)).toHaveValue("2026-08-06T23:00");

    // One modal, not one per row.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  /**
   * The headline assertion: a rename is a patch naming the title and nothing
   * else, sent once. Anything wider would let a dialog opened before a row
   * control was touched write the stale value back over it.
   */
  it("sends exactly { id, title } when only the title is edited", async () => {
    const { user, dialog } = await openEditor();

    const title = within(dialog).getByLabelText("Title");
    await user.clear(title);
    await user.type(title, "Write the rollback");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(api.update.mutate).toHaveBeenCalledTimes(1);
    expect(api.update.mutate.mock.calls[0][0]).toEqual({
      id: TASK_ID,
      title: "Write the rollback",
    });
  });

  it("closes without a round trip when nothing was changed", async () => {
    const { user, dialog } = await openEditor();

    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(api.update.mutate).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reports an invalid title in the field instead of sending it", async () => {
    const { user, dialog } = await openEditor();

    await user.clear(within(dialog).getByLabelText("Title"));
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(api.update.mutate).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Give the task a title.",
    );
  });

  it("keeps status and progress independent inside the dialog too", async () => {
    const { user, dialog } = await openEditor(
      task({ status: "todo", progressPct: 40 }),
    );

    await user.selectOptions(within(dialog).getByLabelText("Status"), "done");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    // Marking it done left the 40% exactly where its owner put it.
    expect(api.update.mutate.mock.calls[0][0]).toEqual({
      id: TASK_ID,
      status: "done",
    });
  });

  it("takes two clicks to delete, because the delete is a hard one", async () => {
    const { user, dialog } = await openEditor();

    await user.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(api.remove.mutate).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Confirm delete" }));
    expect(api.remove.mutate).toHaveBeenCalledTimes(1);
    expect(api.remove.mutate.mock.calls[0][0]).toEqual({ id: TASK_ID });
  });

  it("closes the dialog when the save succeeds", async () => {
    const { user, dialog } = await openEditor();

    await user.clear(within(dialog).getByLabelText("Title"));
    await user.type(within(dialog).getByLabelText("Title"), "Renamed");
    await user.click(within(dialog).getByRole("button", { name: "Save changes" }));

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the create dialog", () => {
  it("seeds a new task with the user's day and creates it", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "New task" }));
    const dialog = screen.getByRole("dialog", { name: "New task" });

    expect(within(dialog).getByLabelText("Day")).toHaveValue("2026-08-06");

    await user.type(within(dialog).getByLabelText("Title"), "Ship phase 2");
    await user.click(within(dialog).getByRole("button", { name: "Create task" }));

    expect(api.create.mutate).toHaveBeenCalledTimes(1);
    expect(api.create.mutate.mock.calls[0][0]).toMatchObject({
      title: "Ship phase 2",
      occursOn: "2026-08-06",
      description: null,
      deadlineAt: null,
      status: "todo",
      progressPct: 0,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers no way to file new work into the overdue bucket", () => {
    render(
      <TaskListLayout view="overdue" clock={CLOCK} query={query({ data: [] })} />,
    );

    expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
    // And says so calmly: an empty overdue list is good news, not a gap.
    expect(
      screen.getAllByRole("heading", { name: "Nothing overdue" }),
    ).toHaveLength(2);
  });
});

/**
 * ===========================================================================
 * RECURRENCE — CRITERIA 13 AND 14
 * ===========================================================================
 *
 * *"A recurring series appears in the Tasks list as one row per occurrence,
 * visually indistinguishable from a one-off except for a repeat affordance"*,
 * and *"row and card name their controls identically"*.
 *
 * The second is not a nicety. Both presentations are always mounted and CSS
 * picks one, so the e2e suite selects by role and relies on the visible copy
 * resolving under the same name in either project. A control added to the row
 * and not to the card halves that coverage silently.
 */

const SERIES_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/** An occurrence of a series that nobody has touched yet. */
function virtualTask(overrides: Partial<Task> = {}): Task {
  return task({
    id: `series:${SERIES_ID}:2026-08-06`,
    seriesId: SERIES_ID,
    virtual: true,
    title: "Team standup",
    ...overrides,
  });
}

describe("a recurring occurrence in the list", () => {
  it("renders one row per occurrence, not a collapsed series row", () => {
    renderList({
      data: [
        virtualTask({ id: `series:${SERIES_ID}:2026-08-06`, occursOn: "2026-08-06" }),
        virtualTask({ id: `series:${SERIES_ID}:2026-08-07`, occursOn: "2026-08-07" }),
      ],
    });

    // Two occurrences, so two of everything — one per presentation, twice over.
    expect(
      screen.getAllByRole("button", { name: "Edit Team standup" }),
    ).toHaveLength(4);
  });

  it("offers exactly the same controls a one-off does", () => {
    // Criterion 13's "visually indistinguishable": the status control, the
    // progress slider and the edit button are the same ones, doing the same
    // thing. Nothing about a rule changes what a task row is.
    renderList({ data: [virtualTask()] });

    expect(
      screen.getAllByRole("combobox", { name: "Status of Team standup" }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("slider", { name: "Progress of Team standup" }),
    ).toHaveLength(2);
    expect(
      screen.getAllByRole("button", { name: "Edit Team standup" }),
    ).toHaveLength(2);
  });

  it("adds the repeat affordance, under the same name in both presentations", () => {
    renderList({ data: [virtualTask()] });

    // Two: the table row and the card. `task-row.tsx` and `task-card.tsx` must
    // stay in step — renaming in one is a silent e2e break in the other.
    expect(
      screen.getAllByRole("button", {
        name: "Repeat rule of Team standup",
      }),
    ).toHaveLength(2);
  });

  it("shows no repeat affordance on a one-off", () => {
    renderList({ data: [task({ title: "A one-off" })] });

    expect(
      screen.queryByRole("button", { name: /^Repeat rule of/ }),
    ).toBeNull();
  });

  it("opens the rule editor from the repeat button", async () => {
    const user = userEvent.setup();
    api.seriesGet.data = {
      id: SERIES_ID,
      title: "Team standup",
      description: null,
      startsOn: "2026-08-03",
      deadlineTime: "09:00",
      rule: {
        freq: "weekly",
        interval: 2,
        byweekday: ["MO", "TH"],
        monthMode: null,
        monthDay: null,
        nthWeek: null,
        nthWeekday: null,
        endsMode: "never",
        endsOn: null,
        endsCount: null,
      },
      rrule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };

    renderList({ data: [virtualTask()] });

    await user.click(
      screen.getAllByRole("button", {
        name: "Repeat rule of Team standup",
      })[0],
    );

    const dialog = screen.getByRole("dialog", { name: "Edit repeat rule" });
    expect(within(dialog).getByLabelText("Title")).toHaveValue("Team standup");
    expect(within(dialog).getByLabelText("Starts on")).toHaveValue("2026-08-03");
    expect(within(dialog).getByLabelText(/^Repeats$/)).toHaveValue("weekly");
    // The live preview, which is the same sentence the list would show.
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Every 2 weeks on Mon, Thu",
    );
  });
});

describe("touching a projected occurrence materialises it", () => {
  it("sends the synthetic reference as the id, so the server can find the rule", async () => {
    const user = userEvent.setup();
    renderList({ data: [virtualTask()] });

    await user.selectOptions(
      screen.getAllByRole("combobox", { name: "Status of Team standup" })[0],
      "in_progress",
    );

    // One mutation, the same one a one-off uses — the branch is on the server.
    expect(api.update.mutate).toHaveBeenCalledTimes(1);
    expect(api.update.mutate.mock.calls[0][0]).toEqual({
      id: `series:${SERIES_ID}:2026-08-06`,
      status: "in_progress",
    });
  });

  it("sends the row's uuid once it has been materialised", async () => {
    const user = userEvent.setup();
    renderList({
      data: [
        task({ seriesId: SERIES_ID, virtual: false, title: "Team standup" }),
      ],
    });

    await user.selectOptions(
      screen.getAllByRole("combobox", { name: "Status of Team standup" })[0],
      "done",
    );

    expect(api.update.mutate.mock.calls[0][0]).toEqual({
      id: TASK_ID,
      status: "done",
    });
  });
});

describe("the task dialog on a recurring occurrence", () => {
  async function openEditor(overrides: Partial<Task> = {}) {
    const user = userEvent.setup();
    renderList({ data: [virtualTask(overrides)] });

    await user.click(
      screen.getAllByRole("button", { name: "Edit Team standup" })[0],
    );
    return { user, dialog: screen.getByRole("dialog", { name: "Edit task" }) };
  }

  it("offers no Delete — the rule would just produce it again", async () => {
    const { dialog } = await openEditor();

    expect(
      within(dialog).queryByRole("button", { name: "Delete" }),
    ).toBeNull();
    // Whereas a one-off still has one.
    cleanup();
    const user = userEvent.setup();
    renderList({ data: [task({ title: "A one-off" })] });
    await user.click(
      screen.getAllByRole("button", { name: "Edit A one-off" })[0],
    );
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete",
      }),
    ).toBeVisible();
  });

  it("makes the Day read-only, because the rule owns it", async () => {
    const { dialog } = await openEditor();

    const day = within(dialog).getByLabelText(/^Day/);
    expect(day).toBeDisabled();
    expect(day).toHaveValue("2026-08-06");
  });

  it("still lets the status and progress be edited — each occurrence owns those", async () => {
    const { dialog } = await openEditor();

    expect(within(dialog).getByLabelText("Status")).toBeEnabled();
    expect(within(dialog).getByLabelText("Progress")).toBeEnabled();
  });
});

describe("creating a repeat rule", () => {
  it("offers its own button beside New task", () => {
    renderList();

    expect(
      screen.getByRole("button", { name: "New repeating task" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "New task" })).toBeVisible();
  });

  it("seeds the rule from the user's day and creates it", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "New repeating task" }));
    const dialog = screen.getByRole("dialog", { name: "New repeating task" });

    // 2026-08-06 is a Thursday, so the picker starts on Thursday and the rule
    // already names a real day.
    expect(within(dialog).getByLabelText("Starts on")).toHaveValue("2026-08-06");
    expect(within(dialog).getByRole("checkbox", { name: "Thursday" })).toBeChecked();

    await user.type(within(dialog).getByLabelText("Title"), "Team standup");
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(api.seriesCreate.mutate).toHaveBeenCalledTimes(1);
    expect(api.seriesCreate.mutate.mock.calls[0][0]).toMatchObject({
      title: "Team standup",
      startsOn: "2026-08-06",
      rule: { freq: "weekly", interval: 1, byweekday: ["TH"] },
    });
  });

  it("reveals the monthly controls and hides the weekday picker on Monthly", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "New repeating task" }));
    const dialog = screen.getByRole("dialog", { name: "New repeating task" });

    expect(within(dialog).getByRole("checkbox", { name: "Monday" })).toBeVisible();

    await user.selectOptions(
      within(dialog).getByLabelText(/^Repeats$/),
      "monthly",
    );

    expect(within(dialog).queryByRole("checkbox", { name: "Monday" })).toBeNull();
    expect(within(dialog).getByLabelText("Monthly on")).toBeVisible();
    expect(within(dialog).getByLabelText("Day of the month")).toBeVisible();
  });

  it("swaps the day-of-month field for the nth-weekday pair", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "New repeating task" }));
    const dialog = screen.getByRole("dialog", { name: "New repeating task" });

    await user.selectOptions(within(dialog).getByLabelText(/^Repeats$/), "monthly");
    await user.selectOptions(
      within(dialog).getByLabelText("Monthly on"),
      "by_nth_weekday",
    );

    expect(within(dialog).queryByLabelText("Day of the month")).toBeNull();
    expect(within(dialog).getByLabelText("Week")).toBeVisible();
    expect(within(dialog).getByLabelText("Day")).toBeVisible();
  });

  it("reveals the count field only for 'after a number of times'", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "New repeating task" }));
    const dialog = screen.getByRole("dialog", { name: "New repeating task" });

    expect(within(dialog).queryByLabelText("Number of times")).toBeNull();

    await user.selectOptions(within(dialog).getByLabelText("Ends"), "after");
    expect(within(dialog).getByLabelText("Number of times")).toBeVisible();

    await user.selectOptions(within(dialog).getByLabelText("Ends"), "on");
    expect(within(dialog).queryByLabelText("Number of times")).toBeNull();
    expect(within(dialog).getByLabelText("Ends on")).toBeVisible();
  });

  it("refuses to submit a weekly rule with no days, naming the picker", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(screen.getByRole("button", { name: "New repeating task" }));
    const dialog = screen.getByRole("dialog", { name: "New repeating task" });

    await user.type(within(dialog).getByLabelText("Title"), "Team standup");
    await user.click(within(dialog).getByRole("checkbox", { name: "Thursday" }));
    await user.click(within(dialog).getByRole("button", { name: "Create" }));

    expect(api.seriesCreate.mutate).not.toHaveBeenCalled();
    expect(
      within(dialog).getByText("Pick at least one day of the week."),
    ).toBeVisible();
  });
});
