import { SimulatorView } from '@/components/admin/simulator-view';
import { PageHeader } from '@/components/layout/page-header';
import { isPlatformAdmin } from '@/lib/admin-guard';
import { requireUser } from '@/lib/auth';

/**
 * The sandbox payment simulator (F12).
 *
 * A client view, because every step it shows is read back from a mutation
 * result or a polled event row - server-rendering it would leave the server's
 * HTML and the client's state disagreeing the moment a delivery lands.
 *
 * Whether the sandbox EXISTS is decided by the server: the view asks the API
 * and renders an explanation when the flag is off. The API refuses a direct
 * call either way, so this page is presentation rather than enforcement.
 */
export const dynamic = 'force-dynamic';

export default async function SimulatorPage() {
  await requireUser();

  // Render NOTHING for a non-administrator. The layout already explains it;
  // without this the output would still travel in the RSC payload (AI_LOG 44).
  if (!(await isPlatformAdmin())) {
    return null;
  }

  return (
    <>
      <PageHeader
        title="Payment simulator"
        description="Deliver a signed card transaction to the real webhook endpoint, without a provider, a card, or any money."
      />

      <SimulatorView />
    </>
  );
}
