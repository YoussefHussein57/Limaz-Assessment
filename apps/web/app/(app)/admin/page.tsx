import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { requireUser } from '@/lib/auth';

/**
 * The platform administration workspace.
 *
 * Same honesty as the manager dashboard: real identity, no invented figures.
 * Company counts and key listings belong to F08, and showing a plausible
 * number here would be a lie somebody has to defend in a review.
 */
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader
        title="Platform administration"
        description="Manage the companies on this deployment and the API keys their backends authenticate with."
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader title="Signed in as" />
          <CardBody className="flex flex-col gap-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <span className="text-text-secondary">Name</span>
              <span className="text-right font-medium text-text">{user.displayName}</span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-text-secondary">Email</span>
              <span className="text-right font-medium break-all text-text">{user.email}</span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-text-secondary">Role</span>
              <Badge tone="accent">Platform admin</Badge>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Scope" />
          <CardBody className="flex flex-col gap-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <span className="text-text-secondary">Company</span>
              <span className="text-right font-medium text-text">None</span>
            </div>
            <p className="text-text-secondary">
              A platform administrator belongs to no company. That is why company-scoped endpoints
              refuse this account rather than quietly returning everything: a missing tenant filter
              means either no rows or all of them, and neither is a safe default.
            </p>
          </CardBody>
        </Card>
      </div>

      <div className="mt-4">
        <Alert tone="info" title="Not built yet">
          Company creation and API key management arrive in F08. The navigation marks each one
          with the feature that delivers it.
        </Alert>
      </div>
    </>
  );
}
