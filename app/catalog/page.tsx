import Catalog from '@/frontend/catalog';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string | string[] }>;
}) {
  const { kind } = await searchParams;
  const category = kind === 'part' || kind === 'monitor' ? kind : 'prebuilt';
  return <Catalog key={category} kind={category} />;
}
