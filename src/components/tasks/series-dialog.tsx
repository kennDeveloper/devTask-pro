"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { Textarea } from "@/components/ui/textarea";
import {
  describeRule,
  ENDS_MODE_OPTIONS,
  FREQUENCY_OPTIONS,
  intervalUnitLabel,
  MONTH_MODE_OPTIONS,
  NTH_WEEK_OPTIONS,
  WEEKDAY_OPTIONS,
} from "@/lib/recurrence/labels";
import { normaliseRule } from "@/lib/recurrence/rule";
import {
  ENDS_COUNT_MAX,
  ENDS_COUNT_MIN,
  INTERVAL_MAX,
  INTERVAL_MIN,
} from "@/lib/tasks/series-validators";
import { DESCRIPTION_MAX_LENGTH, TITLE_MAX_LENGTH } from "@/lib/tasks/validators";
import { cn } from "@/lib/utils";

import {
  buildSeriesInput,
  buildSeriesUpdateInput,
  initialSeriesFormValues,
  toRule,
  type SeriesFormErrors,
  type SeriesFormValues,
} from "./series-form";
import { TagPicker } from "@/components/tags/tag-picker";

import { ReminderSelect } from "./reminder-select";
import { useSeriesActions } from "./use-series-actions";
import { WeekdayPicker } from "./weekday-picker";

import type {
  EndsMode,
  MonthMode,
  NthWeek,
  RecurrenceFrequency,
  Weekday,
} from "@/lib/db/schema";
import type { Series, TaskClock } from "./types";

/**
 * Create and edit a repeat rule.
 *
 * ## Why this is not the task dialog with more fields
 *
 * They have almost nothing in common once you look. A series has no status, no
 * progress and no deadline *instant* — it has a rule and a deadline *time of
 * day*. A one-off has all three and no rule. Merging them leaves half the
 * controls inert at any moment, and makes the two most-used controls in the app
 * meaningless for the thing being edited, because each occurrence carries its
 * own status and progress rather than the series doing so.
 *
 * Keeping them apart also leaves `task-dialog.tsx` untouched, so every phase-2
 * journey through it keeps working unchanged.
 *
 * ## The preview is the same sentence the list shows
 *
 * `describeRule` renders it here and on the repeat button in each row, so what
 * the editor promises and what the list later says cannot drift apart.
 *
 * ## Seeding happens once, at mount
 *
 * `useState`'s initialiser is the whole of it — no effect syncing props into
 * state, so a refetch landing mid-edit cannot overwrite what the user typed.
 * The caller mounts this only while it is open, which is what re-seeds it.
 */

export interface SeriesDialogProps {
  open: boolean;
  onClose: () => void;
  /** Server-resolved. Seeds the start date and names the deadline's timezone. */
  clock: TaskClock;
  /** Absent → create a new series. Present → edit this one. */
  series?: Series | null;
}

export function SeriesDialog({
  open,
  onClose,
  clock,
  series = null,
}: SeriesDialogProps) {
  const formId = React.useId();
  const fieldId = React.useId();
  const { create, update, remove } = useSeriesActions();

  const [values, setValues] = React.useState<SeriesFormValues>(() =>
    initialSeriesFormValues(series, clock),
  );
  const [errors, setErrors] = React.useState<SeriesFormErrors>({});
  /**
   * Deleting a series is the one action here with consequences beyond the row
   * you are looking at — every untouched occurrence it produces disappears — so
   * it takes two deliberate clicks rather than a toast that arrives afterwards.
   */
  const [armedForDelete, setArmedForDelete] = React.useState(false);
  /** The series' **template** tags — copied onto each occurrence as it materialises. */
  const [tagIds, setTagIds] = React.useState<string[]>(
    () => series?.tags.map((tag) => tag.id) ?? [],
  );

  const saving = series ? update.isPending : create.isPending;
  const mutationError = series ? update.error : create.error;

  function setValue<K extends keyof SeriesFormValues>(
    field: K,
    value: SeriesFormValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
    // Editing retracts the previous verdict — a stale error under a field the
    // user has since fixed is worse than no error at all.
    setErrors((current) =>
      current[field] ? { ...current, [field]: undefined } : current,
    );
    if (update.isError) update.reset();
    if (create.isError) create.reset();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (series) {
      const result = buildSeriesUpdateInput(values, series.id);
      if (!result.ok) {
        setErrors(result.errors);
        return;
      }
      setErrors({});
      update.mutate({ ...result.data, tagIds }, { onSuccess: onClose });
      return;
    }

    const result = buildSeriesInput(values);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    create.mutate({ ...result.data, tagIds }, { onSuccess: onClose });
  }

  function handleDelete() {
    if (!series) return;
    if (!armedForDelete) {
      setArmedForDelete(true);
      return;
    }
    remove.mutate({ id: series.id }, { onSuccess: onClose });
  }

  const weekly = values.freq === "weekly";
  const monthly = values.freq === "monthly";
  const preview = describeRule(normaliseRule(toRule(values)));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={series ? "Edit repeat rule" : "New repeating task"}
      description={
        series
          ? "Occurrences you have already worked on keep their status and progress."
          : "One rule, one trackable task per date it names."
      }
      footer={
        <>
          {series && (
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
            {series ? "Save changes" : "Create"}
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

        {errors.form && (
          <Text variant="body-sm" tone="destructive" role="alert">
            {errors.form}
          </Text>
        )}

        <Field
          label="Title"
          htmlFor={`${fieldId}-title`}
          error={errors.title}
          hint="Every occurrence starts with this name."
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
            label="Starts on"
            htmlFor={`${fieldId}-startsOn`}
            error={errors.startsOn}
          >
            <Input
              id={`${fieldId}-startsOn`}
              type="date"
              value={values.startsOn}
              aria-invalid={errors.startsOn ? true : undefined}
              aria-describedby={
                errors.startsOn ? `${fieldId}-startsOn-error` : undefined
              }
              onChange={(event) => setValue("startsOn", event.target.value)}
            />
          </Field>

          <Field
            label="Due at"
            htmlFor={`${fieldId}-deadlineTime`}
            optional
            error={errors.deadlineTime}
            // The control speaks wall clock with no zone. Naming the zone is the
            // only thing that makes "09:00" unambiguous to the person typing it
            // — and the instant is resolved per date, so it stays 09:00 local
            // across a DST change.
            hint={`Read in ${clock.timeZone}, on every occurrence.`}
          >
            <Input
              id={`${fieldId}-deadlineTime`}
              type="time"
              value={values.deadlineTime}
              aria-invalid={errors.deadlineTime ? true : undefined}
              aria-describedby={
                errors.deadlineTime
                  ? `${fieldId}-deadlineTime-error`
                  : `${fieldId}-deadlineTime-hint`
              }
              onChange={(event) => setValue("deadlineTime", event.target.value)}
            />
          </Field>
        </div>

        {/* The template reminder. Like every other series field it seeds an
            occurrence when somebody first touches it and then lets go — so
            changing it here reaches future untouched occurrences only, and an
            occurrence with a lead of its own keeps it. Disabled without a due
            time, because a lead has nothing to count back from. */}
        <Field
          label="Reminder"
          htmlFor={`${fieldId}-reminder`}
          optional
          error={errors.reminderLeadMinutes}
          hint={
            values.deadlineTime
              ? `Emailed before each occurrence, ${clock.timeZone} time.`
              : "Set a due time to enable reminders."
          }
        >
          <ReminderSelect
            id={`${fieldId}-reminder`}
            value={values.reminderLeadMinutes}
            disabled={!values.deadlineTime}
            onChange={(lead) => setValue("reminderLeadMinutes", lead)}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Repeats"
            htmlFor={`${fieldId}-freq`}
            error={errors.freq}
          >
            <SelectControl
              id={`${fieldId}-freq`}
              value={values.freq}
              onChange={(value) =>
                setValue("freq", value as RecurrenceFrequency)
              }
              options={FREQUENCY_OPTIONS}
            />
          </Field>

          <Field
            label={`Every (${intervalUnitLabel(values.freq, values.interval)})`}
            htmlFor={`${fieldId}-interval`}
            error={errors.interval}
          >
            <Input
              id={`${fieldId}-interval`}
              type="number"
              inputMode="numeric"
              min={INTERVAL_MIN}
              max={INTERVAL_MAX}
              step={1}
              value={values.interval}
              aria-invalid={errors.interval ? true : undefined}
              aria-describedby={
                errors.interval ? `${fieldId}-interval-error` : undefined
              }
              onChange={(event) =>
                setValue("interval", Number(event.target.value))
              }
            />
          </Field>
        </div>

        {weekly && (
          <WeekdayPicker
            id={`${fieldId}-byweekday`}
            value={values.byweekday}
            error={errors.byweekday}
            onChange={(days) => setValue("byweekday", days)}
          />
        )}

        {monthly && (
          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Monthly on"
              htmlFor={`${fieldId}-monthMode`}
              error={errors.monthMode}
            >
              <SelectControl
                id={`${fieldId}-monthMode`}
                value={values.monthMode}
                onChange={(value) => setValue("monthMode", value as MonthMode)}
                options={MONTH_MODE_OPTIONS}
              />
            </Field>

            {values.monthMode === "by_date" ? (
              <Field
                label="Day of the month"
                htmlFor={`${fieldId}-monthDay`}
                error={errors.monthDay}
                // Skipped, never clamped — RFC 5545, and the alternative is
                // inventing an occurrence on a date nobody chose.
                hint="A month too short for it is simply skipped."
              >
                <Input
                  id={`${fieldId}-monthDay`}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={31}
                  step={1}
                  value={values.monthDay}
                  aria-invalid={errors.monthDay ? true : undefined}
                  aria-describedby={
                    errors.monthDay
                      ? `${fieldId}-monthDay-error`
                      : `${fieldId}-monthDay-hint`
                  }
                  onChange={(event) =>
                    setValue("monthDay", Number(event.target.value))
                  }
                />
              </Field>
            ) : (
              <div className="grid gap-5 sm:grid-cols-2">
                <Field
                  label="Week"
                  htmlFor={`${fieldId}-nthWeek`}
                  error={errors.nthWeek}
                >
                  <SelectControl
                    id={`${fieldId}-nthWeek`}
                    value={String(values.nthWeek)}
                    onChange={(value) =>
                      setValue("nthWeek", Number(value) as NthWeek)
                    }
                    options={NTH_WEEK_OPTIONS.map((option) => ({
                      value: String(option.value),
                      label: option.label,
                    }))}
                  />
                </Field>

                <Field
                  label="Day"
                  htmlFor={`${fieldId}-nthWeekday`}
                  error={errors.nthWeekday}
                >
                  <SelectControl
                    id={`${fieldId}-nthWeekday`}
                    value={values.nthWeekday}
                    onChange={(value) =>
                      setValue("nthWeekday", value as Weekday)
                    }
                    options={WEEKDAY_OPTIONS.map((option) => ({
                      value: option.value,
                      label: option.label,
                    }))}
                  />
                </Field>
              </div>
            )}
          </div>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Ends" htmlFor={`${fieldId}-endsMode`} error={errors.endsMode}>
            <SelectControl
              id={`${fieldId}-endsMode`}
              value={values.endsMode}
              onChange={(value) => setValue("endsMode", value as EndsMode)}
              options={ENDS_MODE_OPTIONS}
            />
          </Field>

          {values.endsMode === "on" && (
            <Field
              label="Ends on"
              htmlFor={`${fieldId}-endsOn`}
              error={errors.endsOn}
            >
              <Input
                id={`${fieldId}-endsOn`}
                type="date"
                value={values.endsOn}
                aria-invalid={errors.endsOn ? true : undefined}
                aria-describedby={
                  errors.endsOn ? `${fieldId}-endsOn-error` : undefined
                }
                onChange={(event) => setValue("endsOn", event.target.value)}
              />
            </Field>
          )}

          {values.endsMode === "after" && (
            <Field
              label="Number of times"
              htmlFor={`${fieldId}-endsCount`}
              error={errors.endsCount}
              hint="Counted from the start date."
            >
              <Input
                id={`${fieldId}-endsCount`}
                type="number"
                inputMode="numeric"
                min={ENDS_COUNT_MIN}
                max={ENDS_COUNT_MAX}
                step={1}
                value={values.endsCount}
                aria-invalid={errors.endsCount ? true : undefined}
                aria-describedby={
                  errors.endsCount
                    ? `${fieldId}-endsCount-error`
                    : `${fieldId}-endsCount-hint`
                }
                onChange={(event) =>
                  setValue("endsCount", Number(event.target.value))
                }
              />
            </Field>
          )}
        </div>

        <TagPicker
          id={`${fieldId}-tags`}
          value={tagIds}
          onChange={setTagIds}
          legend="Tags for every occurrence"
        />

        {/* The rule in words, live. `role="status"` so a screen reader hears it
            change as the controls move, without an aria-live of our own. */}
        <Text variant="body-sm" tone="secondary" role="status">
          {preview}
        </Text>
      </form>
    </Dialog>
  );
}

/**
 * A native `<select>`, styled like `Input`.
 *
 * The same idiom as `status-control.tsx` and `settings-screen.tsx` rather than a
 * third one: there is still no Select primitive in `src/components/ui`, this
 * task does not own that directory, and a hand-rolled dropdown would leave the
 * app with two keyboard models for the same job. Local to this file because the
 * dialog is the only place with five of them.
 */
function SelectControl({
  id,
  value,
  onChange,
  options,
  className,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
  className?: string;
}) {
  return (
    <select
      id={id}
      name={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={cn(
        "h-11 w-full rounded-md border border-line bg-paper px-3 py-2 text-base text-ink transition-[border-color,box-shadow] duration-150 focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm",
        className,
      )}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}
