import { CompanyDetailView } from '@/components/admin/company-detail-view';
import { isPlatformAdmin } from '@/lib/admin-guard';
import { requireUser } from '@/lib/auth';

/**
 * One company.
 *
 * A client view, for the same reason the review detail is one: this page
 * carries MUTATIONS whose results change what it shows - including a
 * plaintext secret that must live in component state and nowhere else.
 * Server-rendering it would leave the server's HTML and the client's cache
 * disagreeing the moment a key is rotated.
 */
export const dynamic = 'force-dynamic';

export default async function AdminCompanyPage({
  params,
}: {
  params: Promise<{ companyId: string }>;
}) {
  await requireUser();

  // Render NOTHING for a non-administrator. The layout already shows them an
  // explanation; without this the page's output would still travel in the RSC
  // payload behind it (AI_LOG 44).
  if (!(await isPlatformAdmin())) {
    return null;
  }

  const { companyId } = await params;

  return <CompanyDetailView companyId={companyId} />;
}
