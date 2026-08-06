"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { trpc } from "@/lib/trpc/client";

import { NewTaskButton } from "./new-task-button";
import { TaskCard } from "./task-card";
import { TaskDialog } from "./task-dialog";
import { TaskCardsEmpty, TaskTableEmpty } from "./task-empty";
import { taskColumns } from "./task-presentation";
import { TaskRow } from "./task-row";
import { TaskCardListSkeleton, TaskTableSkeleton } from "./task-skeleton";

import type { Task, TaskClock } from "./types";

/**
 * The task list: a table from `md` up, a stack of cards below it.
 *
 * ## Two presentations, four states
 *
 * AGENTS.md: *lists on mobile are cards, never tables*, and *both presentations
 * need their own loading and empty states*. Both trees are always rendered and
 * CSS picks one — which is also why `TaskRow` and `TaskCard` each own their own
 * mutation hook rather than sharing one from here. The hidden copy costs a
 * subscription and nothing else, whereas measuring the viewport in JavaScript to
 * render only one would reintroduce exactly the server/client disagreement the
 * `TaskClock` arrangement exists to prevent.
 *
 * ## Three views, three queries, and why each is its own component
 *
 * `/today` shows the day and the overdue bucket, `/tasks` shows everything, and
 * `/overdue` shows the bucket alone — three different procedures behind one
 * layout. Hooks cannot be called conditionally, so the alternative to the
 * dispatch below is running all three queries and disabling two, which leaves
 * two dead subscriptions on every page. A component per view keeps each hook
 * unconditional and each query the only one that runs.
 *
 * `TaskListLayout` is everything after the data arrives, and it takes the query
 * as a plain object — so it renders in a test without a tRPC provider, and the
 * loading and empty states are reachable by passing a value rather than by
 * intercepting a network call.
 *
 * ## One dialog for the whole list
 *
 * Editing is list-level state, not row-level: a `<dialog>` per row would put
 * dozens of modal elements in the document and let two open at once. It is
 * mounted only while a task is being edited, which is also what re-seeds the
 * form — see the note in `task-dialog.tsx`.
 */

export type TaskListView = "day" | "overdue" | "all";

interface ViewConfig {
  /** Accessible name for the table and the card stack. */
  label: string;
  /** `/today` is already one day, so repeating it down a column is noise. */
  showDay: boolean;
  /**
   * Whether this list offers a way to add a task. Overdue does not: the bucket
   * is derived from deadlines that have already passed, and you do not file new
   * work into the past.
   */
  canCreate: boolean;
  emptyTitle: string;
  emptyBody: string;
}

const VIEWS: Record<TaskListView, ViewConfig> = {
  day: {
    label: "Tasks for today",
    showDay: false,
    canCreate: true,
    emptyTitle: "Nothing on today's list",
    emptyBody:
      "Add the first thing you want to get done, and it will show up here.",
  },
  overdue: {
    label: "Overdue tasks",
    showDay: true,
    canCreate: false,
    // Deliberately calm. This group renders unconditionally above the day's list
    // on the screen the user opens every morning, and an empty overdue list is
    // good news — it must not read as a gap that needs filling.
    emptyTitle: "Nothing overdue",
    emptyBody:
      "Everything with a deadline is either finished or still ahead of you.",
  },
  all: {
    label: "All tasks",
    showDay: true,
    canCreate: true,
    emptyTitle: "No tasks yet",
    emptyBody:
      "Everything you add lands here, whatever day it belongs to and whatever state it is in.",
  },
};

/**
 * The parts of a query this list reads.
 *
 * Narrower than react-query's result on purpose: it is the contract the layout
 * depends on, it is satisfied by all three procedures, and a test can supply it
 * as an object literal.
 */
export interface TaskListQuery {
  data: Task[] | undefined;
  /** First load with nothing cached — the only state that earns a skeleton. */
  isPending: boolean;
  /** Any fetch in flight, including a retry. Drives the retry button's spinner. */
  isFetching: boolean;
  error: { message: string } | null;
  refetch: () => void;
}

export interface TaskListProps {
  view: TaskListView;
  /** Resolved server-side; see `src/lib/time/current-clock.ts`. */
  clock: TaskClock;
  /** Which calendar day `view="day"` shows. Defaults to the user's today. */
  occursOn?: string;
}

export function TaskList({ view, clock, occursOn }: TaskListProps) {
  switch (view) {
    case "day":
      return <DayTaskList clock={clock} occursOn={occursOn ?? clock.today} />;
    case "overdue":
      return <OverdueTaskList clock={clock} />;
    case "all":
      return <AllTaskList clock={clock} />;
  }
}

/**
 * `occursOn` is passed explicitly even though the router would resolve today
 * itself. Both answers are server-resolved, but only this one is the *same*
 * server reading the rows label themselves against — `clock.today` came from
 * `currentUserClock()`, and sending it means the list and the "Today" in each
 * row cannot disagree if the request crosses midnight.
 */
function DayTaskList({ clock, occursOn }: { clock: TaskClock; occursOn: string }) {
  const query = trpc.task.listForDay.useQuery({ occursOn });
  return <TaskListLayout view="day" clock={clock} query={query} />;
}

/**
 * `now` is not sent. It is `z.date()` on the router and the link has no
 * transformer, so it could not survive the wire as a `Date` anyway — and the
 * server's clock is the right one for an absolute comparison the client should
 * not get a vote on.
 */
function OverdueTaskList({ clock }: { clock: TaskClock }) {
  const query = trpc.task.listOverdue.useQuery({});
  return <TaskListLayout view="overdue" clock={clock} query={query} />;
}

function AllTaskList({ clock }: { clock: TaskClock }) {
  const query = trpc.task.list.useQuery();
  return <TaskListLayout view="all" clock={clock} query={query} />;
}

export interface TaskListLayoutProps {
  view: TaskListView;
  clock: TaskClock;
  query: TaskListQuery;
}

export function TaskListLayout({ view, clock, query }: TaskListLayoutProps) {
  const [editing, setEditing] = React.useState<Task | null>(null);

  const config = VIEWS[view];
  const columns = taskColumns(config.showDay);
  const columnCount = columns.length;
  const tasks = query.data;
  const isEmpty = !query.isPending && (tasks?.length ?? 0) === 0;

  // A failed query is not a slow one. A skeleton that never resolves claims the
  // data is still on its way, so the two states must not share a branch.
  if (query.error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Your tasks could not be loaded</CardTitle>
          <CardDescription>{query.error.message}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            loading={query.isFetching}
            onClick={() => query.refetch()}
          >
            Try again
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {config.canCreate && (
        <div className="flex justify-end">
          <NewTaskButton clock={clock} size="sm" />
        </div>
      )}

      {/* ---- md and up: the table ---- */}
      <div data-slot="task-table" className="hidden md:block">
        <Card className="overflow-hidden">
          {/* Named with `aria-label` rather than a `<caption>`: a caption is only
              valid as a table's first child and this one carries no visible text. */}
          <Table aria-label={config.label}>
            {/* The real header stays mounted through loading, so column titles,
                widths and borders never move — only the rows pulse. */}
            <TableHeader>
              <TableRow>
                {columns.map((column) => (
                  <TableHead key={column.key} className={column.className}>
                    {column.labelHidden ? (
                      <span className="sr-only">{column.label}</span>
                    ) : (
                      column.label
                    )}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {query.isPending ? (
                <TaskTableSkeleton columns={columns} />
              ) : isEmpty ? (
                <TaskTableEmpty
                  columnCount={columnCount}
                  title={config.emptyTitle}
                  body={config.emptyBody}
                />
              ) : (
                tasks?.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    clock={clock}
                    showDay={config.showDay}
                    columnCount={columnCount}
                    onEdit={setEditing}
                  />
                ))
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* ---- below md: the cards ---- */}
      <div
        data-slot="task-cards"
        aria-label={config.label}
        className="space-y-3 md:hidden"
      >
        {query.isPending ? (
          <TaskCardListSkeleton />
        ) : isEmpty ? (
          <TaskCardsEmpty title={config.emptyTitle} body={config.emptyBody} />
        ) : (
          tasks?.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              clock={clock}
              showDay={config.showDay}
              onEdit={setEditing}
            />
          ))
        )}
      </div>

      {editing && (
        <TaskDialog
          open
          task={editing}
          clock={clock}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
