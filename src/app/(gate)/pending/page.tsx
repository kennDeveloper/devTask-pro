import type { Metadata } from "next";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Text } from "@/components/ui/text";

export const metadata: Metadata = {
  title: "Awaiting approval",
};

/**
 * Where `profiles.status = 'pending'` lands.
 *
 * Confirming an email address gets you an account; it does not get you in. An
 * administrator has to approve it. The copy says so plainly rather than
 * implying something is still loading or that the user forgot a step.
 */
export default function PendingPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Your account is awaiting approval</CardTitle>
        <CardDescription>
          An administrator reviews every new account before it is switched on.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Text variant="body-sm" tone="secondary">
          There is nothing else you need to do. Once your account is approved,
          your next visit will take you straight into DevTask Pro. If it is
          taking longer than you expect, contact whoever invited you.
        </Text>
      </CardContent>
    </Card>
  );
}
