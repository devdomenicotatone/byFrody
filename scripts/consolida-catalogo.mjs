// Consolidamento catalogo: fonde le 7 schede attuali in 2 prodotti con varianti
// SOLO COLORE (stock 1), spostando le foto cover per-colore nella galleria
// (prodotto_foto) taggate con la variante colore.
//
//   polo-rigata-*    -> 1 prodotto "Polo"    (cat. Polo),    4 varianti colore
//   polo-fantasia-*  -> 1 prodotto "Coreana" (cat. Coreane), 3 varianti colore
//   "Celeste" -> "Bluette".
//
// SICUREZZA (operazione su DB di PRODUZIONE):
//   - DRY-RUN di default: stampa il piano e NON tocca nulla. Serve `--apply`.
//   - Aborta se esistono righe d'ordine sui prodotti (storico ordini): in quel
//     caso il consolidamento andrebbe ripensato (qui ordini attesi = 0).
//   - Fase additiva PRIMA (crea schede/varianti, COPIA le foto, scrive la
//     galleria) e SOLO se tutto riesce esegue la fase distruttiva (elimina le 7
//     vecchie schede + i file storage vecchi). Se la fase additiva fallisce,
//     i dati vecchi restano intatti e lo script e ri-eseguibile (upsert).
//
// Uso:
//   node scripts/consolida-catalogo.mjs            # DRY-RUN: stampa il piano
//   node scripts/consolida-catalogo.mjs --apply    # esegue davvero
//
// Legge NEXT_PUBLIC_SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY da .env.local.

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
const url = env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceKey) {
  console.error("Mancano NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY in .env.local");
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const APPLY = process.argv.includes("--apply");
const BUCKET = "prodotti";
const STOCK = 1;
const COLORE_MAP = { Celeste: "Bluette" };

const GRUPPI = [
  {
    prefix: "polo-rigata-",
    slug: "polo",
    nome: "Polo",
    categoriaSlug: "polo",
    ordineColori: ["Blu", "Grigia", "Bianca", "Bluette"],
  },
  {
    prefix: "polo-fantasia-",
    slug: "coreana",
    nome: "Coreana",
    categoriaSlug: "coreane",
    ordineColori: ["Blu", "Bianca", "Bluette"],
  },
];

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function coloreDaNome(nome) {
  // "Polo colletto rigato — Grigia" -> "Grigia" -> map Celeste->Bluette.
  const parti = nome.split("—");
  const raw = (parti[parti.length - 1] ?? "").trim() || "Unico";
  return COLORE_MAP[raw] ?? raw;
}

console.log(
  APPLY
    ? ">>> MODALITA APPLY: lo script MODIFICHERA il database di produzione.\n"
    : ">>> DRY-RUN: nessuna modifica. Rilancia con --apply per eseguire davvero.\n",
);

// --- 0. Categorie ----------------------------------------------------------
const { data: categorie, error: errCat } = await admin
  .from("categorie")
  .select("id, slug");
if (errCat) {
  console.error("Errore leggendo le categorie:", errCat.message);
  console.error("Hai applicato la migration 20260623120000_categorie_galleria.sql?");
  process.exit(1);
}
const catBySlug = Object.fromEntries((categorie ?? []).map((c) => [c.slug, c.id]));

// --- 1. Lettura sorgenti + piano -------------------------------------------
const piani = [];
const tuttiVecchiId = [];

for (const g of GRUPPI) {
  const { data: sorgenti, error } = await admin
    .from("prodotti")
    .select("id, slug, nome, descrizione, prezzo_cents, valuta")
    .like("slug", `${g.prefix}%`)
    .order("slug", { ascending: true });
  if (error) {
    console.error(`Errore leggendo ${g.prefix}*:`, error.message);
    process.exit(1);
  }
  if (!sorgenti || sorgenti.length === 0) {
    console.log(`! Nessuna scheda trovata per "${g.prefix}*": gruppo ${g.nome} saltato.`);
    continue;
  }

  const colori = sorgenti.map((s) => ({
    colore: coloreDaNome(s.nome),
    coloreSlug: slugify(coloreDaNome(s.nome)),
    vecchioId: s.id,
    vecchiaFoto: `${s.id}/cover.webp`,
  }));
  // Ordina i colori secondo la preferenza del gruppo (cover = primo).
  colori.sort((a, b) => {
    const ia = g.ordineColori.indexOf(a.colore);
    const ib = g.ordineColori.indexOf(b.colore);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const categoriaId = catBySlug[g.categoriaSlug] ?? null;
  const base = sorgenti[0];
  const piano = {
    ...g,
    categoriaId,
    descrizione: base.descrizione,
    prezzoCents: base.prezzo_cents,
    valuta: base.valuta,
    colori,
    vecchiId: sorgenti.map((s) => s.id),
  };
  piani.push(piano);
  tuttiVecchiId.push(...piano.vecchiId);

  console.log(`• ${g.nome}  (slug "${g.slug}", categoria "${g.categoriaSlug}"=${categoriaId ?? "MANCANTE"})`);
  console.log(`    prezzo_cents=${piano.prezzoCents}  da ${sorgenti.length} schede sorgente`);
  for (const c of colori) {
    console.log(
      `    - colore "${c.colore}"  sku="${g.slug}-${c.coloreSlug}"  stock=${STOCK}  foto: ${c.vecchiaFoto} -> <nuovoId>/${c.coloreSlug}.webp`,
    );
  }
  console.log(`    cover = ${colori[0]?.colore ?? "—"}`);
  console.log("");
}

if (piani.length === 0) {
  console.log("Niente da consolidare. Esco.");
  process.exit(0);
}
for (const p of piani) {
  if (!p.categoriaId) {
    console.error(`Categoria "${p.categoriaSlug}" mancante. Applica la migration (seed categorie) prima.`);
    process.exit(1);
  }
}

// --- 2. Guardia storico ordini + carrelli ----------------------------------
const { count: nOrdineRighe } = await admin
  .from("ordine_righe")
  .select("id", { count: "exact", head: true })
  .in("prodotto_id", tuttiVecchiId);
const { count: nCarrello } = await admin
  .from("carrello_righe")
  .select("id", { count: "exact", head: true })
  .in("prodotto_id", tuttiVecchiId);

console.log(`Guardia: ordine_righe sui prodotti coinvolti = ${nOrdineRighe ?? 0}, carrello_righe = ${nCarrello ?? 0}`);
if ((nOrdineRighe ?? 0) > 0) {
  console.error(
    "\nABORT: esistono righe d'ordine sui prodotti da eliminare. Eliminarli spezzerebbe lo storico ordini (ordine_righe.prodotto_id -> SET NULL). Ripensare il consolidamento (soft-delete/rimappatura) prima di procedere.",
  );
  process.exit(1);
}
if ((nCarrello ?? 0) > 0) {
  console.log(
    "! Attenzione: ci sono righe di carrello clienti sui vecchi prodotti; verranno svuotate (CASCADE) all'eliminazione.",
  );
}

if (!APPLY) {
  console.log("\nDRY-RUN completato. Se il piano e corretto, rilancia con:  node scripts/consolida-catalogo.mjs --apply");
  process.exit(0);
}

// ===========================================================================
// FASE ADDITIVA (non distruttiva): crea schede + varianti, COPIA le foto,
// scrive la galleria. Se qualcosa fallisce, i vecchi dati restano intatti.
// ===========================================================================
console.log("\n=== FASE ADDITIVA ===");

for (const p of piani) {
  // 2a. Upsert prodotto consolidato (by slug). Le schede NUOVE nascono
  // attivo=false (nascoste finche non complete, riattivate a fine iterazione);
  // su una scheda gia esistente (re-run) NON tocchiamo 'attivo', cosi non
  // sparisce dalla vetrina mentre la ricostruiamo.
  const { data: giaEsiste } = await admin
    .from("prodotti")
    .select("id")
    .eq("slug", p.slug)
    .maybeSingle();
  const payload = {
    slug: p.slug,
    nome: p.nome,
    descrizione: p.descrizione,
    categoria_id: p.categoriaId,
    prezzo_cents: p.prezzoCents,
    valuta: p.valuta ?? "EUR",
  };
  if (!giaEsiste) payload.attivo = false;
  const { data: prod, error: errProd } = await admin
    .from("prodotti")
    .upsert(payload, { onConflict: "slug" })
    .select("id")
    .single();
  if (errProd) {
    console.error(`ABORT su "${p.nome}" (upsert prodotto):`, errProd.message);
    process.exit(1);
  }
  p.nuovoId = prod.id;
  console.log(`✓ prodotto "${p.nome}"  id=${p.nuovoId}`);

  // 2b. Upsert varianti colore (by sku). stock 1, taglia null.
  for (const c of p.colori) {
    const sku = `${p.slug}-${c.coloreSlug}`;
    const { data: v, error: errVar } = await admin
      .from("varianti")
      .upsert(
        { prodotto_id: p.nuovoId, taglia: null, colore: c.colore, sku, stock: STOCK },
        { onConflict: "sku" },
      )
      .select("id")
      .single();
    if (errVar) {
      console.error(`ABORT variante ${sku}:`, errVar.message);
      process.exit(1);
    }
    c.varianteId = v.id;
  }

  // 2c. COPIA le foto cover vecchie nella cartella del nuovo prodotto.
  for (const c of p.colori) {
    const nuovaPath = `${p.nuovoId}/${c.coloreSlug}.webp`;
    const { data: blob, error: errDl } = await admin.storage
      .from(BUCKET)
      .download(c.vecchiaFoto);
    if (errDl || !blob) {
      console.error(
        `ABORT: impossibile scaricare la foto ${c.vecchiaFoto} (${errDl?.message ?? "vuota"}). Nessuna eliminazione effettuata.`,
      );
      process.exit(1);
    }
    const buf = Buffer.from(await blob.arrayBuffer());
    const { error: errUp } = await admin.storage
      .from(BUCKET)
      .upload(nuovaPath, buf, { upsert: true, contentType: "image/webp" });
    if (errUp) {
      console.error(`ABORT: upload ${nuovaPath} fallito: ${errUp.message}. Nessuna eliminazione effettuata.`);
      process.exit(1);
    }
    const { data: pub } = admin.storage.from(BUCKET).getPublicUrl(nuovaPath);
    c.nuovoUrl = `${pub.publicUrl}?v=${Date.now()}`;
    console.log(`  foto ${c.colore}: ${c.vecchiaFoto} -> ${nuovaPath}`);
  }

  // 2d. Galleria: azzera e reinserisci (idempotente su re-run).
  await admin.from("prodotto_foto").delete().eq("prodotto_id", p.nuovoId);
  const righeFoto = p.colori.map((c, i) => ({
    prodotto_id: p.nuovoId,
    variante_id: c.varianteId,
    url: c.nuovoUrl,
    ordine: i,
  }));
  const { error: errFoto } = await admin.from("prodotto_foto").insert(righeFoto);
  if (errFoto) {
    console.error(`ABORT inserimento galleria "${p.nome}":`, errFoto.message);
    process.exit(1);
  }

  // 2e. Copertina = prima foto; attiva la scheda.
  const { error: errFin } = await admin
    .from("prodotti")
    .update({ immagine_url: p.colori[0]?.nuovoUrl ?? null, attivo: true })
    .eq("id", p.nuovoId);
  if (errFin) {
    console.error(`ABORT finalizzazione "${p.nome}":`, errFin.message);
    process.exit(1);
  }
  console.log(`✓ "${p.nome}" pronto e attivo (${p.colori.length} colori in galleria).`);
}

// ===========================================================================
// FASE DISTRUTTIVA: solo ora che le nuove schede esistono e sono verificate.
// ===========================================================================
console.log("\n=== FASE DISTRUTTIVA ===");

// Riconferma la guardia storico (paranoia: stato puo essere cambiato).
const { count: nOrdineRighe2 } = await admin
  .from("ordine_righe")
  .select("id", { count: "exact", head: true })
  .in("prodotto_id", tuttiVecchiId);
if ((nOrdineRighe2 ?? 0) > 0) {
  console.error("ABORT pre-delete: ordine_righe ora > 0. Le nuove schede sono gia create; eliminazione vecchie NON eseguita.");
  process.exit(1);
}

// Non eliminare per sbaglio una scheda consolidata (slug "polo"/"coreana" non
// e tra i vecchi prefissi, ma difesa in profondita).
const nuoviId = new Set(piani.map((p) => p.nuovoId));
const daEliminare = tuttiVecchiId.filter((id) => !nuoviId.has(id));

// PRIMA il delete DB (toglie le sorgenti -> un eventuale re-run riparte pulito,
// trovando 0 sorgenti). POI la pulizia storage best-effort: un file orfano e
// recuperabile e non blocca nulla, mentre una riga DB orfana con il file gia
// cancellato bloccherebbe la fase additiva al re-run.
const { error: errDel } = await admin.from("prodotti").delete().in("id", daEliminare);
if (errDel) {
  console.error("Errore eliminando le vecchie schede:", errDel.message);
  process.exit(1);
}
console.log(`✓ Eliminate ${daEliminare.length} vecchie schede (varianti via CASCADE).`);

for (const vecchioId of daEliminare) {
  const { data: files, error: errList } = await admin.storage.from(BUCKET).list(vecchioId);
  if (errList) {
    console.warn(`! list storage ${vecchioId} fallita: ${errList.message} — pulizia manuale`);
    continue;
  }
  if (files && files.length > 0) {
    const { error: errRm } = await admin.storage
      .from(BUCKET)
      .remove(files.map((f) => `${vecchioId}/${f.name}`));
    if (errRm) {
      console.warn(`! remove storage ${vecchioId} fallita: ${errRm.message} — pulizia manuale`);
    }
  }
}

console.log("\nFatto. Catalogo consolidato. Controlla /gestore/prodotti e la vetrina.");
