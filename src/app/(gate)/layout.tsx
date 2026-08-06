import Link from "next/link";
import { redirect } from "next/navigation";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

/**
 * Chrome for the two "you are signed in but you cannot come in" screens,
 * /pending and /no-access.
 *
 * (gate) is its own route group precisely so these pages sit OUTSIDE the (app)
 * guard. A pending user is redirected here; if here were also protected they
 * would be redirected from here, forever. `src/lib/access/status-route.ts`
 * lists both paths as always-allowed and tests the loop directly.
 *
 * The sign-out action lives in the layout rather than in each page: it is the
 * one thing a user on either screen can actually do, and neither screen should
 * be a dead end you can only leave by clearing cookies.
 */
export default function GateLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  async function signOut() {
    "use server";

    const supabase = await createClient();
    await supabase.auth.signOut();
    redirect("/sign-in");
  }

  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col">
      <header className="px-6 py-5">
        <Link href="/" aria-label="Home" className="inline-flex items-center">
          <Logo size="md" variant="lockup" />
        </Link>
      </header>

      <main className="flex-1 flex items-start justify-center px-6 pt-8 pb-16">
        <div className="w-full max-w-sm">
          {children}

          <form action={signOut} className="mt-6 flex justify-center">
            <Button type="submit" variant="link">
              Sign out
            </Button>
          </form>
        </div>
      </main>
    </div>
  );
}
