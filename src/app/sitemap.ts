import type { MetadataRoute } from "next";

import { createServerSupabase } from "@/lib/supabase/server";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Sitemap: pagine statiche + una entry per ogni prodotto attivo. Degrada alle
// sole pagine statiche se Supabase non e configurato o la query fallisce.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const statiche: MetadataRoute.Sitemap = [
    { url: `${SITE}/`, changeFrequency: "weekly", priority: 1 },
    {
      url: `${SITE}/vieni-a-trovarci`,
      changeFrequency: "monthly",
      priority: 0.6,
    },
  ];

  try {
    const supabase = await createServerSupabase();
    if (!supabase) return statiche;

    const { data } = await supabase
      .from("prodotti")
      .select("slug")
      .eq("attivo", true);

    const prodotti: MetadataRoute.Sitemap = (data ?? []).map((p) => ({
      url: `${SITE}/prodotti/${p.slug}`,
      changeFrequency: "weekly",
      priority: 0.8,
    }));

    return [...statiche, ...prodotti];
  } catch {
    return statiche;
  }
}
