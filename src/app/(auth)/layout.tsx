import Link from "next/link";
import { Logo } from "@/components/brand/logo";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-paper text-ink flex flex-col">
      <header className="px-6 py-5">
        <Link href="/" aria-label="Home" className="inline-flex items-center">
          <Logo size="md" variant="lockup" />
        </Link>
      </header>
      <main className="flex-1 flex items-start justify-center px-6 pt-8 pb-16">
        <div className="w-full max-w-sm">{children}</div>
      </main>
    </div>
  );
}
