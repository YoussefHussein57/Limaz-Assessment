import { PolicyForm } from '@/components/policy/policy-form';
import { PageHeader } from '@/components/layout/page-header';
import { requireUser } from '@/lib/auth';

/**
 * Company policy settings.
 *
 * A Server Component shell around a client form. The form owns edit state and
 * a mutation, so it has to be a client component; the heading and the company
 * name do not, so they are not.
 */
export const dynamic = 'force-dynamic';

export default async function PolicyPage() {
  const user = await requireUser();

  return (
    <>
      <PageHeader
        title="Policy"
        description={
          user.company
            ? `The rules every expense ${user.company.name} submits is judged against.`
            : 'The rules every submitted expense is judged against.'
        }
      />

      <PolicyForm />
    </>
  );
}
