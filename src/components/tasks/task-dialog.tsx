"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import { DESCRIPTION_MAX_LENGTH, TITLE_MAX_LENGTH } from "@/lib/tasks/validators";

import { TagPicker } from "@/components/tags/tag-picker";

import { ProgressControl } from "./progress-control";
import { ReminderSelect } from "./reminder-select";
import { StatusControl } from "./status-control";
import {
  buildCreateInput,
  buildUpdatePatch,
  initialTaskFormValues,
  type TaskFormErrors,
  type TaskFormValues,
} from "./task-form";
import { useTaskActions } from "./use-task-actions";

import type { Task, TaskClock } from "./types";

/**
 * Create and edit, in one dialog.
 *
 * ## Why one component and not two
 *
 * The fields, the validation and the layout are identical; only the verb and the
 * mutation differ. Two components would be the same JSX twice, and the second
 * copy is the one that stops matching.
 *
 * ## Seeding happens once, at mount
 *
 * `TaskList` mounts this only while a task is being edited, so `useState`'s
 * initialiser is the whole of the seeding logic — no effect syncing props into
 * state, and therefore no chance of a refetch landing mid-edit and overwriting
 * what the user has typed. Closing unmounts it, which discards the draft; that
 * is the expected meaning of Cancel.
 *
 * ## The footer buttons live outside the `<form>`
 *
 * `Dialog` renders `footer` as a sibling of `children`, so the submit button is
 * associated with the form by its `form` attribute rather than by containment.
 * That is what keeps every dialog in the app putting its actions in the same
 * place while still submitting on Enter from any field.
 */

export interface TaskDialogProps {
  open: boolean;
  /** Fires for the close button, Escape and a backdrop click alike. */
  onClose: () => void;
  /** The server-resolved clock. Seeds the date on create; renders the deadline on edit. */
  clock: TaskClock;
  /** Absent → create a new task. Present → edit this one. */
  task?: Task | null;
}

export function TaskDialog({ open, onClose, clock, task = null }: TaskDialogProps) {
  const formId = React.useId();
  const fieldId = React.useId();
  const { create, update, remove } = useTaskActions();

  const [values, setValues] = React.useState<TaskFormValues>(() =>
    initialTaskFormValues(task, clock),
  );
  const [errors, setErrors] = React.useState<TaskFormErrors>({});
  /**
   * A hard delete gets two deliberate clicks. There is no undo and no
   * `deleted_at` on an occurrence, so the confirmation has to be in the path
   * rather than in a toast that arrives after the row is gone.
   */
  const [armedForDelete, setArmedForDelete] = React.useState(false);
  /**
   * Seeded from the task at mount, like every other field. Sent on every submit
   * — the router reads `undefined` as "the picker was not on screen", so a
   * value here always means a deliberate selection.
   */
  const [tagIds, setTagIds] = React.useState<string[]>(
    () => task?.tags.map((tag) => tag.id) ?? [],
  );

  const saving = task ? update.isPending : create.isPending;
  const mutationError = task ? update.error : create.error;

  /**
   * A recurring occurrence is edited here like any other task, with two
   * differences that both follow from the day belonging to the rule rather than
   * to the row:
   *
   * - **The Day control is read-only.** Moving one occurrence to another date
   *   would put a row on a day its series never names; the server refuses that
   *   for an untouched occurrence, and the control should not offer what the
   *   server will not do.
   * - **Delete is not offered.** Deleting an untouched occurrence would be "skip
   *   this one occurrence", which is out of v1; deleting a materialised one only
   *   makes the rule produce it again on the next read, and a delete that does
   *   not stick reads as a bug. The repeat button on the row is the way to
   *   change what a series produces.
   */
  const recurring = Boolean(task?.seriesId);

  /**
   * Read from the *current* form state, not from the task — so clearing the
   * deadline field disables the reminder control in the same keystroke rather
   * than after a save.
   */
  const hasDeadline = values.deadlineLocal !== "";

  function setValue<K extends keyof TaskFormValues>(
    field: K,
    value: TaskFormValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
    // Editing retracts the previous verdict — the same rule `settings-screen.tsx`
    // applies to its "Saved." line. A stale error under a field the user has
    // since fixed is worse than no error at all. Every `TaskFormValues` key is
    // also a `TaskFormErrors` key, which is why the two shapes are named to line
    // up rather than mapped through a lookup.
    setErrors((current) =>
      current[field] ? { ...current, [field]: undefined } : current,
    );
    if (update.isError) update.reset();
    if (create.isError) create.reset();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (task) {
      const result = buildUpdatePatch(values, task, clock.timeZone);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setErrors({});

      // An untouched form is not a no-op request: `taskUpdateInput` rejects a
      // patch that names nothing, and rightly — so there is simply nothing to
      // send and the dialog closes.
      if (result.data === null) {
        onClose();
        return;
      }

      update.mutate(
        { ...result.data, ...changedTagIds() },
        { onSuccess: onClose },
      );
      return;
    }

    const result = buildCreateInput(values, clock.timeZone);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    create.mutate({ ...result.data, tagIds }, { onSuccess: onClose });
  }

  /**
   * `{ tagIds }` only when the selection actually moved, and `{}` otherwise.
   *
   * The same rule every other field in this dialog follows: an edit sends what
   * changed, not the whole task. Sending the selection unconditionally would be
   * harmless today — nothing but this dialog writes tags — but it would make the
   * payload stop describing the user's edit, which is the property that stops a
   * dialog opened at 09:00 and submitted at 09:05 writing back something a row
   * control changed in between.
   */
  function changedTagIds(): { tagIds?: string[] } {
    const before = [...(task?.tags.map((tag) => tag.id) ?? [])].sort();
    const after = [...tagIds].sort();

    const same =
      before.length === after.length &&
      before.every((id, index) => id === after[index]);

    return same ? {} : { tagIds };
  }

  function handleDelete() {
    if (!task) return;
    if (!armedForDelete) {
      setArmedForDelete(true);
      return;
    }
    remove.mutate({ id: task.id }, { onSuccess: onClose });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={task ? "Edit task" : "New task"}
      description={
        task
          ? recurring
            ? "Changes save to this occurrence only — the rest of the series is untouched."
            : "Changes save to this task only."
          : "Only you can see this. Everything but the title is optional."
      }
      footer={
        <>
          {task && !recurring && (
            <Button
              variant="destructive"
              loading={remove.isPending}
              onClick={handleDelete}
              className="sm:mr-auto"
            >
              {armedForDelete ? "Confirm delete" : "Delete"}
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving}>
            {task ? "Save changes" : "Create task"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-5" noValidate>
        {(mutationError ?? remove.error) && (
          <div
            role="alert"
            className="rounded-md border border-trip/40 bg-trip-soft px-3.5 py-3"
          >
            <Text variant="body-sm" tone="destructive">
              {(mutationError ?? remove.error)?.message}
            </Text>
          </div>
        )}

        <Field
          label="Title"
          htmlFor={`${fieldId}-title`}
          error={errors.title}
          hint="What you will recognise it by in the list."
        >
          <Input
            id={`${fieldId}-title`}
            value={values.title}
            maxLength={TITLE_MAX_LENGTH}
            autoComplete="off"
            aria-invalid={errors.title ? true : undefined}
            aria-describedby={
              errors.title ? `${fieldId}-title-error` : `${fieldId}-title-hint`
            }
            onChange={(event) => setValue("title", event.target.value)}
          />
        </Field>

        <Field
          label="Notes"
          htmlFor={`${fieldId}-description`}
          optional
          error={errors.description}
        >
          <Textarea
            id={`${fieldId}-description`}
            value={values.description}
            maxLength={DESCRIPTION_MAX_LENGTH}
            aria-invalid={errors.description ? true : undefined}
            aria-describedby={
              errors.description ? `${fieldId}-description-error` : undefined
            }
            onChange={(event) => setValue("description", event.target.value)}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Day"
            htmlFor={`${fieldId}-occursOn`}
            error={errors.occursOn}
            hint={recurring ? "Set by the repeat rule." : undefined}
          >
            <Input
              id={`${fieldId}-occursOn`}
              type="date"
              value={values.occursOn}
              readOnly={recurring}
              disabled={recurring}
              aria-invalid={errors.occursOn ? true : undefined}
              aria-describedby={
                errors.occursOn
                  ? `${fieldId}-occursOn-error`
                  : recurring
                    ? `${fieldId}-occursOn-hint`
                    : undefined
              }
              onChange={(event) => setValue("occursOn", event.target.value)}
            />
          </Field>

          <Field
            label="Deadline"
            htmlFor={`${fieldId}-deadline`}
            optional
            error={errors.deadlineLocal}
            // The control speaks wall clock with no zone; naming the zone here is
            // the only thing that makes "23:00" unambiguous to the person typing it.
            hint={`Read in ${clock.timeZone}.`}
          >
            <Input
              id={`${fieldId}-deadline`}
              type="datetime-local"
              value={values.deadlineLocal}
              aria-invalid={errors.deadlineLocal ? true : undefined}
              aria-describedby={
                errors.deadlineLocal
                  ? `${fieldId}-deadline-error`
                  : `${fieldId}-deadline-hint`
              }
              onChange={(event) => setValue("deadlineLocal", event.target.value)}
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Status" htmlFor={`${fieldId}-status`} error={errors.status}>
            <StatusControl
              id={`${fieldId}-status`}
              value={values.status}
              onChange={(status) => setValue("status", status)}
            />
          </Field>

          {/* A lead counts back from the deadline, so without one there is
              nothing to count back from and the control has nothing to mean.
              Disabled rather than hidden: a control that appears when you fill
              in a deadline is a layout that moves under the cursor. */}
          <Field
            label="Reminder"
            htmlFor={`${fieldId}-reminder`}
            optional
            error={errors.reminderLeadMinutes}
            hint={
              hasDeadline
                ? `Emailed to you, ${clock.timeZone} time.`
                : "Set a deadline to enable reminders."
            }
          >
            <ReminderSelect
              id={`${fieldId}-reminder`}
              value={values.reminderLeadMinutes}
              disabled={!hasDeadline}
              onChange={(lead) => setValue("reminderLeadMinutes", lead)}
            />
          </Field>
        </div>

        <TagPicker
          id={`${fieldId}-tags`}
          value={tagIds}
          onChange={setTagIds}
        />

        {/* Deliberately its own field and not derived from the one above it: a
            task can be Done at 40%, and neither control writes to the other. */}
        <Field
          label="Progress"
          htmlFor={`${fieldId}-progress`}
          error={errors.progressPct}
          hint="Set by hand. It is not tied to the status."
        >
          <ProgressControl
            id={`${fieldId}-progress`}
            value={values.progressPct}
            onCommit={(progressPct) => setValue("progressPct", progressPct)}
          />
        </Field>
      </form>
    </Dialog>
  );
}
