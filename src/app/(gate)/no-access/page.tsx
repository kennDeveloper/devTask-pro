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
  title: "No access",
};

/**
 * Where `profiles.status = 'rejected'` and `'suspended'` both land.
 *
 * One screen for two states, on purpose. The copy does not say which of them
 * applies, does not say why, and does not imply the user did something wrong —
 * the reason is between them and their administrator, and speculating here
 * would either be inaccurate or leak an admin's reasoning to the account
 * holder.
 */
export default function NoAccessPage() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>This account does not have access</CardTitle>
        <CardDescription>
          Your sign-in worked, but the account is not currently able to use
          DevTask Pro.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Text variant="body-sm" tone="secondary">
          Access is managed by an administrator. If you believe this is a
          mistake, contact them and they can review the account.
        </Text>
      </CardContent>
    </Card>
  );
}
