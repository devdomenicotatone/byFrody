// One-off: imposta le taglie M..3XL sui due polo, generando la griglia
// colore × taglia esattamente come fa l'editor varianti (stesso SKU). Idempotente:
// upsert per sku + elimina i vecchi sku non piu nel set. Le foto restano legate
// al colore (prodotto_foto.colore), quindi la galleria non si tocca.
// Uso: node scripts/imposta-taglie.mjs

import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

function leggiEnv(file) {
  try {
    const txt = readFileSync(file, "utf8");
    const env = {};
    for (const riga of txt.split(/\r?\n/)) {
      const m = riga.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    return env;
  } catch {
    return {};
  }
}

const env = { ...leggiEnv(".env.local"), ...process.env };
const admin = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function slugify(testo) {
  return testo
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const SLUGS = [
  "polo-colletto-rigato-con-inserti",
  "polo-collo-coreana-con-dettagli-fantasia",
];
const TAGLIE = ["M", "L", "XL", "2XL", "3XL"];

for (const slug of SLUGS) {
  const { data: prod } = await admin
    .from("prodotti")
    .select("id, slug")
    .eq("slug", slug)
    .maybeSingle();
  if (!prod) {
    console.log(`! ${slug}: prodotto non trovato, salto.`);
    continue;
  }

  const { data: vars } = await admin
    .from("varianti")
    .select("id, colore, taglia, sku, stock")
    .eq("prodotto_id", prod.id);

  const colori = [...new Set((vars ?? []).map((v) => v.colore).filter(Boolean))];
  if (colori.length === 0) {
    console.log(`! ${slug}: nessun colore, salto.`);
    continue;
  }

  const desiderate = [];
  for (const c of colori)
    for (const t of TAGLIE)
      desiderate.push({
        prodotto_id: prod.id,
        colore: c,
        taglia: t,
        sku: slugify([slug, c, t].join("-")),
        stock: 1,
      });
  const skuDesiderati = new Set(desiderate.map((d) => d.sku));

  const { error: upErr } = await admin
    .from("varianti")
    .upsert(desiderate, { onConflict: "sku" });
  if (upErr) {
    console.error(`! ${slug}: upsert fallito: ${upErr.message}`);
    continue;
  }

  const obsolete = (vars ?? [])
    .filter((v) => !skuDesiderati.has(v.sku))
    .map((v) => v.id);
  if (obsolete.length) {
    const { error: delErr } = await admin
      .from("varianti")
      .delete()
      .in("id", obsolete);
    if (delErr) console.error(`! ${slug}: delete fallito: ${delErr.message}`);
  }

  console.log(
    `✓ ${slug}: ${colori.length} colori × ${TAGLIE.length} taglie = ${desiderate.length} varianti (eliminate ${obsolete.length} vecchie).`,
  );
}

console.log("Fatto.");
