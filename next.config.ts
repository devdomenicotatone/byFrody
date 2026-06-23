import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Le foto prodotto sono servite dal bucket pubblico di Supabase Storage.
    // Nota: NON impostiamo `search` (le url avranno un cache-bust `?v=...`,
    // che con `search: ""` verrebbe rifiutato da next/image — usato nella PDP).
    remotePatterns: [
      {
        protocol: "https",
        hostname: "ozbsslebqtzslfpqpwyz.supabase.co",
        pathname: "/storage/v1/object/public/**",
      },
    ],
    // Next 16 richiede di dichiarare esplicitamente le quality ammesse.
    qualities: [75],
  },
  experimental: {
    // L'upload foto passa da una Server Action. Il flusso "Genera da foto" puo
    // inviare piu immagini in un'unica richiesta (prodotto + etichetta), quindi
    // alziamo il limite del body per non farle rigettare al confine del framework.
    serverActions: {
      bodySizeLimit: "12mb",
    },
  },
};

export default nextConfig;
