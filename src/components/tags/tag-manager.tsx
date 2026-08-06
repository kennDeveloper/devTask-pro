"use client";

import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { TAG_COLORS, type TagColor } from "@/lib/db/schema";
import {
  isDuplicateTagName,
  TAG_MESSAGES,
  TAG_NAME_MAX_LENGTH,
} from "@/lib/tasks/tag-validators";
import { trpc } from "@/lib/trpc/client";
import { cn } from "@/lib/utils";

import { useTagActions } from "./use-tag-actions";

/**
 * Create, rename, recolour and delete tags — a card on `/settings`.
 *
 * ## Why a card and not a route
 *
 * Its own route would need a nav entry, and `nav-config.tsx` is a file phase 5
 * also owns — a merge conflict bought for a screen that is a list of a dozen
 * short strings. A card is also the honest size: managing tags is something you
 * do rarely and briefly, unlike the list you open every morning.
 *
 * ## The duplicate check happens twice, on purpose
 *
 * Locally, so the user is told before the round trip; and in the database, where
 * `tags_user_name_uniq` is the actual rule. Both compare through
 * `normaliseTagName`, so they cannot disagree about what "the same name" means —
 * and the local one is a courtesy rather than the guarantee, because two
 * requests can both pass a read and only one can win the insert.
 */
export function TagManager() {
  const query = trpc.tag.list.useQuery();
  const { create, update, remove } = useTagActions();

  const [draft, setDraft] = React.useState("");
  const [draftColor, setDraftColor] = React.useState<TagColor>("neutral");
  const [localError, setLocalError] = React.useState<string | undefined>();
  /** Which tag is armed for deletion. Two clicks, like every other hard delete. */
  const [armed, setArmed] = React.useState<string | null>(null);

  const tags = query.data ?? [];

  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const name = draft.trim();
    if (!name) {
      setLocalError(TAG_MESSAGES.nameRequired);
      return;
    }
    if (isDuplicateTagName(name, tags)) {
      setLocalError(TAG_MESSAGES.duplicate);
      return;
    }

    setLocalError(undefined);
    create.mutate(
      { name, color: draftColor },
      {
        onSuccess: () => {
          setDraft("");
          setDraftColor("neutral");
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags</CardTitle>
        <CardDescription>
          Labels you can put on any task. Deleting one takes it off everything it
          was on and deletes no work.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-5">
        <form onSubmit={handleCreate} className="flex flex-wrap items-end gap-2">
          <div className="min-w-40 flex-1 space-y-1.5">
            <Text variant="label" asChild>
              <label htmlFor="tag-manager-name">New tag</label>
            </Text>
            <Input
              id="tag-manager-name"
              value={draft}
              maxLength={TAG_NAME_MAX_LENGTH}
              autoComplete="off"
              aria-invalid={localError ? true : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                if (localError) setLocalError(undefined);
                if (create.isError) create.reset();
              }}
            />
          </div>

          <ColorChoice
            id="tag-manager-color"
            value={draftColor}
            onChange={setDraftColor}
          />

          <Button type="submit" loading={create.isPending}>
            Add tag
          </Button>
        </form>

        {(localError ?? create.error) && (
          <Text variant="body-sm" tone="destructive" role="alert">
            {localError ?? create.error?.message}
          </Text>
        )}

        {query.isPending ? (
          <div className="space-y-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : tags.length === 0 ? (
          <Text variant="body-sm" tone="muted">
            No tags yet. Add one above and it will be offered on every task.
          </Text>
        ) : (
          <ul aria-label="Your tags" className="space-y-2">
            {tags.map((tag) => (
              <li
                key={tag.id}
                className="flex flex-wrap items-center gap-2 border-b border-line pb-2 last:border-b-0 last:pb-0"
              >
                <Badge tone={tag.color}>{tag.name}</Badge>

                <Input
                  aria-label={`Rename ${tag.name}`}
                  defaultValue={tag.name}
                  maxLength={TAG_NAME_MAX_LENGTH}
                  className="h-9 w-40"
                  // Committed on blur rather than per keystroke: a rename is one
                  // decision, and a mutation per character would be dozens of
                  // writes and dozens of list invalidations.
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (!name || name === tag.name) {
                      event.target.value = tag.name;
                      return;
                    }
                    if (isDuplicateTagName(name, tags, tag.id)) {
                      event.target.value = tag.name;
                      return;
                    }
                    update.mutate({ id: tag.id, name });
                  }}
                />

                <ColorChoice
                  id={`tag-color-${tag.id}`}
                  label={`Colour of ${tag.name}`}
                  value={tag.color}
                  onChange={(color) => update.mutate({ id: tag.id, color })}
                />

                <Button
                  variant="destructive"
                  size="sm"
                  className="ml-auto"
                  loading={remove.isPending && armed === tag.id}
                  aria-label={
                    armed === tag.id
                      ? `Confirm delete ${tag.name}`
                      : `Delete ${tag.name}`
                  }
                  onClick={() => {
                    if (armed !== tag.id) {
                      setArmed(tag.id);
                      return;
                    }
                    remove.mutate(
                      { id: tag.id },
                      { onSuccess: () => setArmed(null) },
                    );
                  }}
                >
                  {armed === tag.id ? "Confirm" : "Delete"}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {(update.error ?? remove.error) && (
          <Text variant="body-sm" tone="destructive" role="alert">
            {(update.error ?? remove.error)?.message}
          </Text>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The colour, as a native `<select>`.
 *
 * Same idiom as `status-control.tsx` and the rule editor rather than a third
 * one. A swatch grid would be prettier and would be a second keyboard model for
 * a choice between six named things.
 */
function ColorChoice({
  id,
  value,
  onChange,
  label = "Colour",
}: {
  id: string;
  value: TagColor;
  onChange: (color: TagColor) => void;
  label?: string;
}) {
  return (
    <select
      id={id}
      name={id}
      value={value}
      aria-label={label}
      onChange={(event) => onChange(event.target.value as TagColor)}
      className={cn(
        "h-9 rounded-md border border-line bg-paper px-2 text-sm text-ink",
        "focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25",
      )}
    >
      {TAG_COLORS.map((color) => (
        <option key={color} value={color}>
          {color}
        </option>
      ))}
    </select>
  );
}
