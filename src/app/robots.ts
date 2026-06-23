import type { MetadataRoute } from "next";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

// Indicizza la vetrina pubblica; tiene fuori area gestore e pagine
// transazionali/private (ordine gated da token, checkout, carrello).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/gestore", "/ordine/", "/checkout/", "/carrello"],
    },
    sitemap: `${SITE}/sitemap.xml`,
  };
}
