import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { AccountListLayout, type AccountListQuery } from "./account-list";
import {
  actionControlName,
  resetControlName,
} from "./account-presentation";

import type { Account, AdminViewer } from "./types";

/**
 * The account list, both presentations, against a stubbed tRPC client.
 *
 * ## Why the client is mocked rather than wrapped in a provider
 *
 * A real `TRPCProvider` would need a running `/api/trpc`, and the interesting
 * assertions here are about *what is sent* and *what is offered*, not about the
 * transport: that a suspend does not fire until it is confirmed, that a pending
 * row offers Approve and Reject and not Suspend, that the admin's own row has no
 * buttons at all. Stubbing the hooks makes the payload directly observable. The
 * transport is proven by `src/lib/trpc/routers/admin.test.ts` and by
 * `tests/integration/`.
 */

interface MutationOptions {
  onSuccess?: () => void;
}

const api = vi.hoisted(() => {
  interface MutationStub {
    hookOptions?: { onSuccess?: () => void };
    mutate: ReturnType<typeof vi.fn>;
    reset: ReturnType<typeof vi.fn>;
    variables: unknown;
    isPending: boolean;
    isSuccess: boolean;
    isError: boolean;
    error: { message: string } | null;
  }

  function stub(): MutationStub {
    const mutation: MutationStub = {
      hookOptions: undefined,
      mutate: vi.fn(),
      reset: vi.fn(),
      variables: undefined,
      isPending: false,
      isSuccess: false,
      isError: false,
      error: null,
    };
    mutation.mutate.mockImplementation((input: unknown) => {
      mutation.variables = input;
      mutation.hookOptions?.onSuccess?.();
    });
    return mutation;
  }

  return {
    invalidate: vi.fn(),
    setStatus: stub(),
    sendPasswordReset: stub(),
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
      useUtils: () => ({ admin: { invalidate: api.invalidate } }),
      admin: {
        setStatus: {
          useMutation: (o?: MutationOptions) => bind(api.setStatus, o),
        },
        sendPasswordReset: {
          useMutation: (o?: MutationOptions) => bind(api.sendPasswordReset, o),
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
  for (const mutation of [api.setStatus, api.sendPasswordReset]) {
    mutation.variables = undefined;
    mutation.isPending = false;
    mutation.isSuccess = false;
    mutation.isError = false;
    mutation.error = null;
  }
});

const VIEWER: AdminViewer = {
  id: "aaaaaaaa-1111-4111-8111-111111111111",
  email: "admin@example.com",
  displayName: "The Admin",
};

const MEMBER_ID = "bbbbbbbb-2222-4222-8222-222222222222";

function account(overrides: Partial<Account> = {}): Account {
  return {
    id: MEMBER_ID,
    email: "ada@example.com",
    displayName: null,
    role: "member",
    status: "pending",
    createdAt: "2026-08-01T00:00:00.000Z",
    approvedAt: null,
    lastSignInAt: null,
    ...overrides,
  };
}

function query(overrides: Partial<AccountListQuery> = {}): AccountListQuery {
  return {
    data: [account()],
    isPending: false,
    isFetching: false,
    error: null,
    refetch: vi.fn(),
    ...overrides,
  };
}

function renderList(overrides: Partial<AccountListQuery> = {}) {
  return render(
    <AccountListLayout viewer={VIEWER} query={query(overrides)} />,
  );
}

/** The table copy, addressed the way a desktop Playwright project would. */
function table() {
  return screen.getByRole("table", { name: "Accounts" });
}

describe("both presentations are always rendered", () => {
  /**
   * AGENTS.md: a `<Table>` inside `hidden md:block` and a card stack inside
   * `md:hidden`, both in the DOM, CSS picking one. jsdom applies no media
   * queries, so a test sees both — which is exactly what lets the naming
   * assertion below be meaningful.
   */
  it("renders the table and the card list at once", () => {
    const { container } = renderList();

    expect(container.querySelector('[data-slot="account-table"]')).not.toBeNull();
    expect(container.querySelector('[data-slot="account-cards"]')).not.toBeNull();
  });

  /**
   * THE ONE THAT PROTECTS THE E2E SUITE.
   *
   * Both copies of every control are in the DOM and Playwright's role engine
   * resolves to whichever is displayed, so a name spelled differently in the row
   * and the card fails on exactly one project and reads as flakiness. Phase 2
   * could only forbid that drift; here `AccountRow` and `AccountCard` render the
   * same `<AccountActions>`, and this asserts it stayed that way.
   */
  it("gives the row and the card byte-identical control names", () => {
    renderList({ data: [account({ status: "pending" })] });

    for (const name of [
      actionControlName("approve", "ada@example.com"),
      actionControlName("reject", "ada@example.com"),
      resetControlName("ada@example.com"),
    ]) {
      // Exactly two: one in the table, one in the card stack. Anything else
      // means the two presentations have drifted apart.
      expect(screen.getAllByRole("button", { name })).toHaveLength(2);
    }
  });
});

describe("which actions a row offers", () => {
  it.each([
    ["pending", ["Approve", "Reject"], ["Suspend", "Reinstate"]],
    ["active", ["Suspend"], ["Approve", "Reject", "Reinstate"]],
    ["rejected", ["Approve"], ["Reject", "Suspend", "Reinstate"]],
    ["suspended", ["Reinstate"], ["Approve", "Reject", "Suspend"]],
  ] as const)(
    "a %s account offers %j and not %j",
    (status, offered, withheld) => {
      renderList({ data: [account({ status })] });
      const row = within(table());

      for (const label of offered) {
        expect(
          row.getByRole("button", { name: `${label} ada@example.com` }),
        ).toBeInTheDocument();
      }
      for (const label of withheld) {
        expect(
          row.queryByRole("button", { name: `${label} ada@example.com` }),
        ).toBeNull();
      }
    },
  );

  it("offers a password reset whatever the status", () => {
    for (const status of ["pending", "active", "rejected", "suspended"] as const) {
      const { unmount } = renderList({ data: [account({ status })] });
      expect(
        within(table()).getByRole("button", {
          name: resetControlName("ada@example.com"),
        }),
      ).toBeInTheDocument();
      unmount();
    }
  });
});

describe("a non-destructive action fires immediately", () => {
  it("approves with the account id and the action, and nothing else", async () => {
    const user = userEvent.setup();
    renderList({ data: [account({ status: "pending" })] });

    await user.click(
      within(table()).getByRole("button", {
        name: actionControlName("approve", "ada@example.com"),
      }),
    );

    expect(api.setStatus.mutate).toHaveBeenCalledTimes(1);
    expect(api.setStatus.mutate).toHaveBeenCalledWith({
      userId: MEMBER_ID,
      action: "approve",
    });
  });

  it("invalidates the admin cache on success, so the row moves out of the queue", async () => {
    const user = userEvent.setup();
    renderList({ data: [account({ status: "suspended" })] });

    await user.click(
      within(table()).getByRole("button", {
        name: actionControlName("reinstate", "ada@example.com"),
      }),
    );

    expect(api.invalidate).toHaveBeenCalled();
  });
});

describe("a destructive action confirms first (criterion 13)", () => {
  it("does not fire suspend until the dialog is confirmed", async () => {
    const user = userEvent.setup();
    renderList({ data: [account({ status: "active" })] });

    await user.click(
      within(table()).getByRole("button", {
        name: actionControlName("suspend", "ada@example.com"),
      }),
    );

    // The dialog is up and nothing has been sent.
    expect(api.setStatus.mutate).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("heading", { name: /suspend this account\?/i }).length,
    ).toBeGreaterThan(0);

    await user.click(
      screen.getAllByRole("button", {
        name: "Confirm: Suspend ada@example.com",
      })[0],
    );

    expect(api.setStatus.mutate).toHaveBeenCalledWith({
      userId: MEMBER_ID,
      action: "suspend",
    });
  });

  it("sends nothing when the confirm is cancelled", async () => {
    const user = userEvent.setup();
    renderList({ data: [account({ status: "pending" })] });

    await user.click(
      within(table()).getByRole("button", {
        name: actionControlName("reject", "ada@example.com"),
      }),
    );
    await user.click(screen.getAllByRole("button", { name: "Cancel" })[0]);

    expect(api.setStatus.mutate).not.toHaveBeenCalled();
  });

  it("names the account in the dialog, so the wrong row is visible before it fires", async () => {
    const user = userEvent.setup();
    renderList({ data: [account({ status: "active" })] });

    await user.click(
      within(table()).getByRole("button", {
        name: actionControlName("suspend", "ada@example.com"),
      }),
    );

    expect(screen.getAllByText("ada@example.com").length).toBeGreaterThan(0);
  });
});

describe("the admin's own row", () => {
  const self = () =>
    account({ id: VIEWER.id, email: VIEWER.email, status: "active", role: "admin" });

  /**
   * Presentation only — `routers/admin.ts` refuses a self-targeted action
   * whatever the browser sends, which is what criterion 10 actually asks for.
   * This stops the admin being offered a button that would then fail.
   */
  it("offers no status action and no password reset", () => {
    renderList({ data: [self()] });
    const row = within(table());

    for (const label of ["Approve", "Reject", "Suspend", "Reinstate"]) {
      expect(
        row.queryByRole("button", { name: `${label} ${VIEWER.email}` }),
      ).toBeNull();
    }
    expect(
      row.queryByRole("button", { name: resetControlName(VIEWER.email) }),
    ).toBeNull();
  });

  it("says why the buttons are missing rather than leaving a blank cell", () => {
    renderList({ data: [self()] });
    expect(within(table()).getByText("You")).toBeInTheDocument();
  });

  it("still offers actions on everybody else", () => {
    renderList({ data: [self(), account({ status: "pending" })] });

    expect(
      within(table()).getByRole("button", {
        name: actionControlName("approve", "ada@example.com"),
      }),
    ).toBeInTheDocument();
  });
});

describe("the password reset", () => {
  it("sends the account id and reports the send in words", async () => {
    const user = userEvent.setup();
    renderList();

    await user.click(
      within(table()).getByRole("button", {
        name: resetControlName("ada@example.com"),
      }),
    );

    expect(api.sendPasswordReset.mutate).toHaveBeenCalledWith({
      userId: MEMBER_ID,
    });
  });

  it("never renders anything resembling a recovery link", () => {
    api.sendPasswordReset.isSuccess = true;
    const { container } = renderList();

    expect(screen.getAllByRole("status")[0]).toHaveTextContent(
      /reset email sent/i,
    );
    expect(container.querySelector("a[href*='token']")).toBeNull();
    expect(container.textContent).not.toMatch(/access_token|type=recovery/);
  });
});

describe("in-flight and error states", () => {
  /** Criterion 14: the button tied to the in-flight action carries the spinner. */
  it("marks only the acting button busy", () => {
    api.setStatus.isPending = true;
    api.setStatus.variables = { userId: MEMBER_ID, action: "approve" };

    renderList({ data: [account({ status: "pending" })] });
    const row = within(table());

    expect(
      row.getByRole("button", {
        name: actionControlName("approve", "ada@example.com"),
      }),
    ).toHaveAttribute("aria-busy", "true");
    expect(
      row.getByRole("button", {
        name: actionControlName("reject", "ada@example.com"),
      }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("shows a failed action as an alert on the row", () => {
    api.setStatus.isError = true;
    api.setStatus.error = { message: "This is the last active administrator" };

    renderList({ data: [account({ status: "active" })] });

    expect(screen.getAllByRole("alert")[0]).toHaveTextContent(
      /last active administrator/i,
    );
  });
});

describe("loading, empty and error states — one of each, per presentation", () => {
  it("renders a skeleton in both presentations on first load", () => {
    const { container } = renderList({ data: undefined, isPending: true });

    expect(
      container.querySelectorAll('[data-slot="account-row-skeleton"]').length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('[data-slot="account-card-skeleton"]').length,
    ).toBeGreaterThan(0);
  });

  it("keeps the real table header mounted while loading, so nothing shifts", () => {
    renderList({ data: undefined, isPending: true });

    expect(
      within(table()).getByRole("columnheader", { name: "Account" }),
    ).toBeInTheDocument();
  });

  it("renders an empty state in both presentations", () => {
    const { container } = renderList({ data: [] });

    expect(
      container.querySelector('[data-slot="accounts-table-empty"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-slot="accounts-cards-empty"]'),
    ).not.toBeNull();
    // A real heading, so it is reachable by role rather than only by text —
    // which matters when both copies are in the DOM.
    expect(
      screen.getAllByRole("heading", { name: /no accounts yet/i }).length,
    ).toBe(2);
  });

  /** A failed query is not a slow one; the two must not share a branch. */
  it("shows an error card with a retry instead of a skeleton", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    const { container } = renderList({
      data: undefined,
      error: { message: "Admin role required" },
      refetch,
    });

    expect(screen.getByText("Admin role required")).toBeInTheDocument();
    expect(
      container.querySelector('[data-slot="account-row-skeleton"]'),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });
});

describe("what the admin tier shows about an account", () => {
  it("leads with the email and shows a display name underneath when there is one", () => {
    renderList({ data: [account({ displayName: "Ada Lovelace" })] });
    const row = within(table());

    expect(row.getByText("ada@example.com")).toBeInTheDocument();
    expect(row.getByText("Ada Lovelace")).toBeInTheDocument();
  });

  it("says 'Never' for an account that has not signed in", () => {
    renderList({ data: [account({ lastSignInAt: null })] });
    expect(within(table()).getByText("Never")).toBeInTheDocument();
  });

  it("renders the signup date and last sign-in in a fixed zone", () => {
    renderList({
      data: [
        account({
          createdAt: "2026-08-01T00:00:00.000Z",
          lastSignInAt: "2026-08-05T09:30:00.000Z",
        }),
      ],
    });
    const row = within(table());

    expect(row.getByText("1 Aug 2026")).toBeInTheDocument();
    expect(row.getByText("5 Aug 2026, 09:30 UTC")).toBeInTheDocument();
  });

  /**
   * CRITERION 6, FROM THE UI SIDE. The admin tier shows account metadata and
   * nothing about what anybody uses the app for. This is the cheap regression
   * guard for somebody adding "just a task count" to a column.
   */
  it("renders no task column and no task-shaped word anywhere", () => {
    renderList({
      data: [account({ status: "active" }), account({ id: "other" })],
    });

    const headers = screen
      .getAllByRole("columnheader")
      .map((h) => h.textContent?.toLowerCase() ?? "");
    expect(headers).toEqual([
      "account",
      "status",
      "signed up",
      "last sign-in",
      "actions",
    ]);

    const body = table().textContent?.toLowerCase() ?? "";
    for (const word of ["task", "overdue", "todo", "in progress", "progress"]) {
      expect(body).not.toContain(word);
    }
  });
});
