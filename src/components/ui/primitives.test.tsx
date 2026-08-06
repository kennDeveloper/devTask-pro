import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton, TableRowsSkeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";
import { Logo } from "@/components/brand/logo";

/**
 * Render smoke tests. These do not assert on styling — the point is that
 * every primitive mounts, and that the few behaviours other tasks depend on
 * (Button `loading`, Field error wiring, Tabs switching) actually work.
 */
// vitest.config.ts does not enable `globals`, so React Testing Library's
// auto-cleanup never registers itself. Unmount explicitly or every render
// stacks up in the same document and role queries match across tests.
afterEach(cleanup);

describe("ui primitives", () => {
  it("renders a Button", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("defaults Button to type=button so it never submits by accident", () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveAttribute(
      "type",
      "button",
    );
  });

  it("renders a loading Button: spinner shown, disabled, label kept", () => {
    const { container } = render(<Button loading>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });

    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-loading", "true");
    // Label stays mounted so the button does not resize mid-action.
    expect(button).toHaveTextContent("Save");
    expect(container.querySelector("svg.animate-spin")).not.toBeNull();
  });

  it("renders a Button asChild without nesting a button", () => {
    render(
      <Button asChild>
        <a href="/today">Today</a>
      </Button>,
    );
    expect(screen.getByRole("link", { name: "Today" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a Card", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Today</CardTitle>
          <CardDescription>Nothing due yet.</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
      </Card>,
    );
    expect(
      screen.getByRole("heading", { name: "Today" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Nothing due yet.")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
  });

  it("renders an Input", () => {
    render(<Input placeholder="you@example.com" />);
    expect(screen.getByPlaceholderText("you@example.com")).toBeInTheDocument();
  });

  it("renders a Field with a label bound to its control", () => {
    render(
      <Field label="Email" htmlFor="email" hint="We never share it.">
        <Input id="email" />
      </Field>,
    );
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByText("We never share it.")).toBeInTheDocument();
  });

  it("renders a Field error in place of the hint", () => {
    render(
      <Field label="Email" htmlFor="email" hint="Hint" error="Enter an email.">
        <Input id="email" />
      </Field>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an email.");
    expect(screen.queryByText("Hint")).toBeNull();
  });

  it("renders a Badge in every tone", () => {
    render(
      <>
        <Badge>default</Badge>
        <Badge tone="neutral">neutral</Badge>
        <Badge tone="success" dot>
          active
        </Badge>
        <Badge tone="warning">pending</Badge>
        <Badge tone="danger">rejected</Badge>
        <Badge tone="info">info</Badge>
      </>,
    );
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("rejected")).toBeInTheDocument();
  });

  it("renders a Skeleton", () => {
    const { container } = render(<Skeleton className="h-6 w-40" />);
    expect(
      container.querySelector('[data-slot="skeleton"]'),
    ).toBeInTheDocument();
  });

  it("renders table skeleton rows that mirror the real column count", () => {
    render(
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Task</TableHead>
            <TableHead>Due</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRowsSkeleton rows={4} columns={3} />
        </TableBody>
      </Table>,
    );
    // 1 header row + 4 skeleton rows.
    expect(screen.getAllByRole("row")).toHaveLength(5);
    expect(screen.getAllByRole("cell")).toHaveLength(12);
  });

  it("renders a Separator", () => {
    const { container } = render(<Separator />);
    expect(
      container.querySelector('[data-slot="separator"]'),
    ).toBeInTheDocument();
  });

  it("renders Tabs and shows only the active panel", () => {
    render(
      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="activity">Activity panel</TabsContent>
      </Tabs>,
    );
    expect(screen.getByText("Overview panel")).toBeInTheDocument();
    expect(screen.queryByText("Activity panel")).toBeNull();
  });

  it("renders Text variants with their default tags", () => {
    render(<Text variant="h2">Heading</Text>);
    expect(screen.getByRole("heading", { name: "Heading" }).tagName).toBe("H2");
  });

  it("renders the Logo", () => {
    render(<Logo />);
    expect(screen.getByRole("img", { name: /logo/i })).toBeInTheDocument();
    expect(screen.getByText("DevTask Pro")).toBeInTheDocument();
  });

  it("renders a Textarea", () => {
    render(<Textarea aria-label="Notes" defaultValue="hello" />);
    expect(screen.getByLabelText("Notes")).toHaveValue("hello");
  });
});

/**
 * Dialog wraps the native `<dialog>` element, which jsdom does not implement —
 * `tests/setup.ts` shims `showModal`/`close`. What that shim can prove is the
 * wiring this component owns: that `open` is reflected imperatively, that the
 * element's own `close` event is what drives `onClose`, and that the accessible
 * name is attached. What it cannot prove — focus trapping, the top layer, an
 * inert background — is exactly what the native element was chosen for, and is
 * left to `e2e/`.
 */
describe("Dialog", () => {
  function Harness({ onClose = () => {} }: { onClose?: () => void }) {
    return (
      <Dialog open title="Edit task" description="Change the details" onClose={onClose}>
        <p>Body</p>
      </Dialog>
    );
  }

  it("opens when `open` is true and exposes its title as the accessible name", () => {
    render(<Harness />);
    const dialog = screen.getByRole("dialog", { name: "Edit task" });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute("open");
  });

  it("stays closed when `open` is false", () => {
    render(
      <Dialog open={false} title="Edit task" onClose={() => {}}>
        <p>Body</p>
      </Dialog>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("calls onClose from the element's own close event, which is what Escape fires", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    // Escape does not pass through a React handler — the browser closes the
    // element directly and fires `close`. Wiring onClose to the close button
    // instead would leave the parent's state stale on Escape, so this asserts
    // the element-event path specifically.
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    dialog.close();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("describes itself with the description when one is given", () => {
    render(<Harness />);
    expect(screen.getByRole("dialog")).toHaveAccessibleDescription(
      "Change the details",
    );
  });
});
