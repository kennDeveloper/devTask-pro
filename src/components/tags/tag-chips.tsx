import { Badge } from "@/components/ui/badge";

import type { TagColor } from "@/lib/db/schema";

/**
 * The tags on a task, as badges.
 *
 * ## Why the colour needs no translation
 *
 * `tags.color` stores a `Badge` **tone name**, not a hex — 0006 constrains it to
 * exactly the six tones `badge.tsx` implements. So a tag renders by handing its
 * stored value straight to `tone`, and the dark theme adjusts it like every other
 * badge in the app. A stored hex would have been a colour literal that reached
 * the DOM without ever passing through `src/components/**`, which is the rule
 * `AGENTS.md` states and the spirit it states it in.
 *
 * ## One accessible name, used by both presentations
 *
 * The row and the card render this same component, so the group is named once,
 * here — `Tags on <title>` — and cannot drift between them. That is the e2e rule
 * from `AGENTS.md`: both presentations are always mounted and Playwright's role
 * engine resolves to whichever is visible, which only works if they agree.
 */

export interface TagChipsProps {
  /** Used to build the group's accessible name. */
  title: string;
  tags: ReadonlyArray<{ id: string; name: string; color: TagColor }>;
  className?: string;
}

export function TagChips({ title, tags, className }: TagChipsProps) {
  // Nothing at all rather than an empty labelled group — an untagged task should
  // not announce a "Tags on …" region containing silence.
  if (tags.length === 0) return null;

  return (
    <ul
      // `list` + `listitem` rather than a div of badges: it is a set of things,
      // and a screen reader saying "list, 2 items" is the useful summary.
      aria-label={`Tags on ${title}`}
      className={className ?? "flex flex-wrap items-center gap-1"}
    >
      {tags.map((tag) => (
        <li key={tag.id}>
          <Badge tone={tag.color}>{tag.name}</Badge>
        </li>
      ))}
    </ul>
  );
}
