# Rollout — Spedizione "a spedizione" (corriere + Stripe)

> Checklist operativa per attivare la spedizione calcolata. Il **codice è già pronto**
> (tsc + lint puliti): qui ci sono solo i passi **manuali** di messa in produzione.
> Scenario: **Solo Italia, <50 spedizioni/mese, da zero senza contratto corriere**,
> abbigliamento leggero. Aggregatore scelto: **Packlink (pay-per-use, niente canone)**.

## Cosa fa (in breve)

La spedizione viene addebitata in **due flussi**, entrambi via Stripe Checkout:

| Flusso | Quando si usa | Chi fissa la spedizione | Come |
|---|---|---|---|
| **Diretto** | prodotti in pronta consegna (`disponibilita_su_richiesta = false`) | il **cliente sceglie la zona** sulla pagina Stripe | `shipping_options`: *Italia continentale* / *Isole e aree disagiate*, **gratis ≥ 89 €** |
| **Su richiesta** (default) | prodotti `disponibilita_su_richiesta = true` | il **gestore** in "Conferma disponibilità" | voce fissa "Spedizione" col costo concordato |

In entrambi i casi il **webhook** salva su `ordini`: `costo_spedizione_cents`, `spedizione_indirizzo`
(indirizzo scelto su Stripe) e allinea `totale_cents` all'incassato reale (merce + spedizione).

> ⚠️ **Limite Stripe (per scelta):** Stripe Checkout *hosted* non ricalcola la spedizione
> live sul CAP. Quindi il flusso diretto usa **fasce per zona** (il cliente seleziona la
> sua). Un cliente delle isole *potrebbe* scegliere "continentale": a questi volumi è una
> perdita trascurabile, blindabile in futuro col controllo CAP nel webhook.

---

## Pre-requisiti

- [ ] Progetto Supabase attivo (le env `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` già configurate).
- [ ] Stripe in **test mode** funzionante (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`).
- [ ] CF/P.IVA del negozio per la fatturazione dell'aggregatore.

---

## Step 1 — Applica la migration al DB

La migration è additiva (aggiunge colonne + estende la RPC `finalizza_ordine_pagato`),
**non distruttiva**.

```bash
# Progetto Supabase collegato (consigliato):
npx supabase db push

# In alternativa: incolla ed esegui il contenuto del file nel SQL Editor di Supabase.
```

File: [`supabase/migrations/20260625100000_spedizione.sql`](../supabase/migrations/20260625100000_spedizione.sql)

**Verifica** (SQL Editor):

```sql
-- Le colonne devono esistere:
select column_name from information_schema.columns
 where table_name = 'ordini'
   and column_name in ('costo_spedizione_cents','spedizione_indirizzo');

-- La RPC deve avere la nuova firma (6 argomenti):
select pg_get_function_identity_arguments(oid)
  from pg_proc where proname = 'finalizza_ordine_pagato';
-- atteso: p_session_id text, p_email text, p_total integer, p_righe jsonb,
--         p_shipping_cents integer, p_indirizzo jsonb
```

- [ ] Migration applicata e verificata.

---

## Step 2 — Configura le tariffe (env)

I default funzionano già (5,90 / 8,90 / gratis ≥ 89 €). Le tariffe per zona sono
**server-only** (no `NEXT_PUBLIC_`): si leggono a runtime → per cambiarle basta
modificarle e **riavviare**, niente rebuild.

In `.env.local` (vedi [`.env.example`](../.env.example)):

```bash
# Soglia spedizione gratuita (pubblica: la usa la barra "spedizione gratis"). 8900 = 89,00 €
NEXT_PUBLIC_FREE_SHIPPING_CENTS=8900
# Tariffe per zona (server-only). Centesimi.
SHIPPING_IT_CONTINENTE_CENTS=590   # 5,90 €
SHIPPING_IT_ISOLE_CENTS=890        # 8,90 €
```

- [ ] Env impostate (o lasciati i default consapevolmente).

---

## Step 3 — Account corriere + preventivi reali

I prezzi "vetrina" online sono risultati **fuorvianti**: le tariffe nette vere si
ottengono solo dai preventivi nel pannello.

- [ ] Apri un account **Packlink PRO (Free)** — e opzionalmente **SpedirePRO** per confronto.
- [ ] Fai **2-3 preventivi reali** per un pacco 0,5–1 kg: una destinazione *continentale*
      e una *isole*, leggendo il **netto con supplementi inclusi** (fuel, isole/aree disagiate).
- [ ] **Tara le env** dello Step 2 in base al costo reale + un piccolo cuscinetto.
      Verifica che la soglia **89 €** copra il costo medio spedizione + margine.

> Per <50 spedizioni/mese **non serve l'API**: si stampano le etichette a mano dal
> pannello Packlink. L'integrazione API (es. Sendcloud Shipping Prices) è roba da crescita.

---

## Step 4 — Test in Stripe test-mode

Avvia l'inoltro del webhook in un terminale dedicato e copia il `whsec_…` in
`STRIPE_WEBHOOK_SECRET`:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Carta test: `4242 4242 4242 4242`, scadenza futura, CVC qualsiasi.

**Flusso DIRETTO** (serve un prodotto con `disponibilita_su_richiesta = false`):
- [ ] Aggiungi al carrello → mini-cart → "Paga".
- [ ] Su Stripe compaiono le 2 opzioni di spedizione (o **"Spedizione gratuita"** se il
      carrello è ≥ 89 €). Scegli la zona, inserisci l'indirizzo, paga.
- [ ] L'ordine in DB risulta `pagato` con `costo_spedizione_cents`, `spedizione_indirizzo`
      e `totale_cents` = merce + spedizione.

**Flusso SU RICHIESTA** (prodotto default):
- [ ] Invia una richiesta da `/carrello`.
- [ ] In `/gestore/ordini` imposta **"Spedizione €"** e clicca **Conferma disponibilità**.
- [ ] Apri `/ordine/[token]`: il breakdown mostra Subtotale → Spedizione → Totale; arriva
      l'email col totale finale.
- [ ] "Paga ora" → su Stripe c'è la voce **"Spedizione"** col costo concordato → paga.
- [ ] L'ordine risulta `pagato` con i campi spedizione valorizzati.

**Query di controllo** (SQL Editor):

```sql
select stato, totale_cents, costo_spedizione_cents, spedizione_indirizzo
  from public.ordini
 order by creato_il desc limit 5;
```

- [ ] Entrambi i flussi verificati end-to-end in test mode.

---

## Step 5 — Go-live

- [ ] Passa le chiavi Stripe da `sk_test_…`/`pk_test_…` a `sk_live_…`/`pk_live_…`.
- [ ] Configura l'endpoint webhook **live** nella dashboard Stripe → `…/api/stripe/webhook`,
      e aggiorna `STRIPE_WEBHOOK_SECRET` con quello dell'endpoint live.
- [ ] Conferma le tariffe definitive nelle env e **riavvia** l'app.
- [ ] Primo ordine reale di prova (anche di importo basso) per validare l'incasso.

---

## File toccati (riferimento)

**MVP / flusso diretto**
- [`supabase/migrations/20260625100000_spedizione.sql`](../supabase/migrations/20260625100000_spedizione.sql) — colonne `ordini` + RPC estesa
- [`supabase/schema.sql`](../supabase/schema.sql) — canonical allineato
- [`src/lib/spedizione.ts`](../src/lib/spedizione.ts) — `opzioniSpedizione()` (unico punto di verità del costo)
- [`src/app/api/checkout/route.ts`](../src/app/api/checkout/route.ts) — `shipping_options` nel checkout diretto
- [`src/app/api/stripe/webhook/route.ts`](../src/app/api/stripe/webhook/route.ts) — persiste costo + indirizzo
- [`src/lib/types.ts`](../src/lib/types.ts), [`src/lib/supabase/database.types.ts`](../src/lib/supabase/database.types.ts), [`.env.example`](../.env.example)

**Passo 2 / flusso su richiesta**
- [`src/lib/gestore/ordini-actions.ts`](../src/lib/gestore/ordini-actions.ts) — `confermaOrdineAction(id, costoSpedizioneCents)`
- [`src/lib/ordini.ts`](../src/lib/ordini.ts) — `creaCheckoutOrdineAction` con voce "Spedizione"
- [`src/components/gestore/ListaOrdini.tsx`](../src/components/gestore/ListaOrdini.tsx) — campo "Spedizione €"
- [`src/app/(gestore)/gestore/(app)/ordini/page.tsx`](../src/app/(gestore)/gestore/(app)/ordini/page.tsx) — select aggiornata
- [`src/app/(vetrina)/ordine/[token]/page.tsx`](../src/app/(vetrina)/ordine/[token]/page.tsx) — breakdown costi

---

## Limiti noti / evoluzioni future

- **Loophole isole** (flusso diretto): il cliente auto-seleziona la zona. Blindabile col
  controllo del CAP nel webhook (annulla/aggiusta se la zona non torna).
- **Peso non considerato**: tariffa per zona, non per peso. Per l'abbigliamento leggero
  (ordine tipico < 1 kg) va bene. Se servirà far pagare di più gli ordini voluminosi:
  aggiungere `peso_grammi` al prodotto e passare a fasce peso×zona.
- **Tariffe live multi-zona / UE**: richiederebbero un checkout custom (Payment Element +
  API corriere). Da valutare solo con la crescita (UE / volumi alti).
