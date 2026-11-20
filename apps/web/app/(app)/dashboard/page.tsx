import { PageHeader } from '@/components/layout/page-header';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardBody, CardHeader } from '@/components/ui/card';
import { requireUser } from '@/lib/auth';

/**
 * The manager workspace.
 *
 * It shows the REAL identity and company the server resolved, and says plainly
 * what is not built yet. There are deliberately no statistics, no charts and
 * no sample figures: every number on this page would be invented, and an
 * invented number is a thing to be asked about in a review that nobody can
 * defend. The assessment forbids it outright, and it would be the wrong call
 * anyway.
 */
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader
        title={`Welcome, ${user.displayName.split(' ')[0]}`}
        description="Your company workspace. Expense review and policy settings arrive in the next features."
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
              <Badge tone="accent">Manager</Badge>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Company" />
          <CardBody className="flex flex-col gap-3 text-sm">
            <div className="flex items-start justify-between gap-3">
              <span className="text-text-secondary">Name</span>
              <span className="text-right font-medium text-text">
                {user.company?.name ?? 'Not assigned'}
              </span>
            </div>
            <div className="flex items-start justify-between gap-3">
              <span className="text-text-secondary">Tenant</span>
              {/* The id the server resolved from the session, shown so the
                  tenant boundary is visible rather than asserted. */}
              <span className="tabular text-right font-mono text-xs break-all text-text-secondary">
                {user.company?.id ?? '-'}
              </span>
            </div>
            <p className="pt-1 text-text-secondary">
              Every request you make is scoped to this company by the server. It is never taken
              from anything the browser sends.
            </p>
          </CardBody>
        </Card>
      </div>

      <div className="mt-4">
        <Alert tone="info" title="Not built yet">
          Expenses, reviews and policy settings are the next features. The navigation marks each
          one with the feature that delivers it, rather than hiding them or linking to a page that
          does not exist.
        </Alert>
      </div>
    </>
  );
}
