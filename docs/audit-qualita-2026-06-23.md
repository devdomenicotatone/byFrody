## Sintesi esecutiva

Il codebase è una piccola ma reale applicazione e-commerce in produzione, ben strutturata e coerente con le sue convenzioni dichiarate (modello di autorizzazione RLS + verifySession, degrado graduale, prezzi in centesimi interi). La salute complessiva è buona: nessun bypass di autenticazione, nessuna SQL injection, nessun segreto hardcoded. Il problema più importante e urgente è la **gestione del flusso di pagamento Stripe nel webhook**: decremento dello stock non atomico, non idempotente e ordinato male rispetto al modello di retry di Stripe, che converge in un rischio concreto di oversell con perdita di denaro e disallineamento dell'inventario. A questo si affianca una **macchina a stati degli ordini priva di guardie di transizione** che, combinata con la riapertura del pagamento, abilita un doppio addebito. Il resto è di qualità medio-alta: alcune lacune di robustezza (errori Supabase ingoiati, timeout SMTP mancanti), un debito di type-safety strutturale (client Supabase non tipizzati), e una quantità sana di duplicazione facilmente eliminabile. Per un negozio di questa scala il livello qualitativo è solido; il lavoro va concentrato sul perimetro pagamenti/ordini.

## Problemi critici e ad alto impatto

### 🔴 Decremento stock nel webhook: non atomico, non idempotente, ordinato male (oversell / perdita di denaro)
*Segnalato da stripe-payments, error-handling-robustness e nextjs-framework — più findings fusi.*

- **Dove**: `src/app/api/stripe/webhook/route.ts:41-83` (guard 41-43, flip a `pagato` 49-58, `decrementaStock` chiamato a 82, read-modify-write a 119-133, `listLineItems` a 96).
- **Problema**: tre difetti convergenti. (1) `decrementaStock` legge lo stock in Node, calcola `Math.max(0, stock - qta)` e riscrive con un UPDATE semplice: nessun decremento atomico, nessun lock, nessuna `WHERE` condizionale → due consegne concorrenti dello stesso evento/variante perdono un decremento (lost update). (2) L'ordine viene messo a `pagato` (51-58) **prima** di decrementare lo stock (82), e l'unica guardia di idempotenza è `if (ordine.stato === 'pagato') return` (41-43): se `decrementaStock` lancia (rate limit/network su `listLineItems`, update fallito), il 500 fa ritentare Stripe ma il retry rientra, vede `pagato` e ritorna subito → il decremento non avviene **mai più**. (3) Gli errori di `select` (119) e `update` (130) sono ignorati (supabase-js ritorna `{error}`, non lancia), quindi un decremento fallito è silenzioso.
- **Rischio**: ordine pagato con stock non scalato → oversell di inventario fisico, perdita di denaro e insoddisfazione cliente. Critico per blast radius sul percorso denaro.
- **Fix**: rendere il decremento atomico via RPC Postgres (`update varianti set stock = greatest(0, stock - p_qta) where id = p_id`, chiamata con `supabase.rpc()`). Tracciare il completamento con un flag idempotente dedicato (es. `ordini.stock_scalato boolean`): cortocircuitare il flusso solo quando `stato='pagato' AND stock_scalato=true`, altrimenti rieseguire e impostare `stock_scalato=true` solo dopo successo provato. Catturare `{error}` su select e update e lanciare/500 sul fallimento così Stripe ritenta. Il solo riordino (decrementa-poi-marca) non basta: aprirebbe il rischio simmetrico di doppio decremento.

### 🔴 Macchina a stati ordini senza guardie di transizione → doppio addebito possibile
*Segnalato da correctness-cart-orders.*

- **Dove**: `src/lib/gestore/ordini-actions.ts:19-80` (`aggiornaStato`, `confermaOrdineAction`); riapertura pagamento in `src/lib/ordini.ts:175-180`.
- **Problema**: `aggiornaStato` (usata da `annullaOrdineAction`/`segnaPagatoOrdineAction`) e `confermaOrdineAction` eseguono UPDATE incondizionati senza controllare lo `stato` corrente. Quindi: (1) un ordine `annullato` può essere marcato `pagato`; (2) un ordine `pagato` (stock già scalato via Stripe) può tornare `annullato`, nascondendo un pagamento reale; (3) `confermaOrdineAction` può riportare un ordine `pagato` a `confermato`, che lo rende di nuovo pagabile via `creaCheckoutOrdineAction` (la cui guardia blocca solo `stato==='pagato'`) → **il cliente può essere addebitato due volte**. Nessuna enforcement a livello DB. In contrasto, il webhook si protegge con `.neq('stato','pagato')`.
- **Rischio**: doppio addebito, perdita di tracciabilità contabile, inventario disallineato.
- **Fix**: UPDATE condizionati che filtrano sullo stato sorgente ammesso e trattano 0 righe come errore: `confermaOrdineAction` solo da `in_attesa` (`.eq('stato','in_attesa')` + `maybeSingle()`); `segnaPagato` solo da `in_attesa`/`confermato` (`.in('stato',[...])`); `annulla` rifiuta se `pagato` (`.neq('stato','pagato')`). Inoltre `segnaPagatoOrdineAction` **non decrementa lo stock** a differenza del percorso Stripe → inventario sovrastimato dopo pagamento manuale: allineare. Idealmente CHECK/trigger DB o funzione di transizione.

### 🟠 Testo di errore corallo (#ff5c5c) su bianco: contrasto sotto WCAG AA
*Segnalato da a11y-ux-seo.*

- **Dove**: `src/components/cart/ModuloRichiesta.tsx:54,75,116`; pattern ripetuto in `BloccoAcquisto.tsx:89,121`, `BloccoRichiesta.tsx:120`, `PulsantePaga.tsx:50`, `CartItem.tsx:110`, `FormProdotto.tsx:301,365`, `FormLogin.tsx:51`; token in `src/app/globals.css:24`.
- **Problema**: corallo su sfondo bianco/surface ha contrasto ~2.9:1, sotto il minimo AA 4.5:1 per testo normale. È il colore standard di **tutti** i messaggi di errore/validazione/alert dello storefront — esattamente il testo che un utente in stato di errore deve leggere.
- **Rischio**: utenti ipovedenti non leggono gli errori di form, pagamento e disponibilità; barriera di accessibilità reale.
- **Fix**: introdurre un token errore più scuro per il testo (es. `--coral-ink: #d62828`, ~5:1 su bianco) in `globals.css` (`:root` + `@theme inline`) e sostituire `text-coral` → `text-coral-ink` su tutte le occorrenze di testo errore/alert; mantenere `#ff5c5c` per i fill dei pulsanti/icone. Affiancare un'icona (non solo colore) come miglioria.

## Problemi medi

**Pagamenti / webhook**
- **Eventi async/expiry ignorati** (`webhook/route.ts:166-179`, root in `checkout/route.ts:89-97`): si agisce solo su `checkout.session.completed` senza controllare `payment_status`; metodi a regolamento asincrono possono essere marcati `pagato` prematuramente o, via `async_payment_succeeded`, non finalizzati mai. `checkout.session.expired` non gestito → ordini `in_attesa` orfani. Fix: gate su `payment_status === 'paid' || 'no_payment_required'`, instradare `async_payment_succeeded` nello stesso finalize, oppure restringere `payment_method_types: ['card']` e documentarlo.
- **Mix carrello diretto + su-richiesta** (`checkout/route.ts:54-78`): `/api/checkout` costruisce line item da **tutte** le righe senza filtro su `disponibilita_su_richiesta`, così un articolo su-richiesta può essere addebitato subito, bypassando la conferma del gestore. Fix: propagare il flag in `leggiCarrello` (manca in `cart.ts:124`) e rifiutare/nascondere il pulsante di pagamento per carrelli misti.

**Carrello / correttezza**
- **Articoli su-richiesta non incrementabili dal carrello** (`CartItem.tsx:42,141`): `maxQuantita = max(stock, quantita)` disabilita il `+` per varianti su-richiesta (stock 0). Fix: aggiungere `disponibilita_su_richiesta` al select di `leggiCarrello` (`cart.ts:124`) e non limitare il `+` né mostrare "Solo N rimasti" per questi articoli.
- **Errori di scrittura carrello ingoiati** (`cart.ts:274-294,355-359,390-394`): update/insert/delete non controllano `{error}`; l'azione ritorna `ok:true` su una mutazione fallita (il re-read maschera il fallimento). Fix: destrutturare `{error}` e ritornare `esitoCorrente(false,'errore')` in caso di errore.

**Email / affidabilità**
- **Nessun timeout SMTP** (`email.ts:39-44`): default nodemailer ~10 min; gli invii sono awaited dentro Server Action (`ordini-actions.ts:60`, `ordini.ts:121`), quindi uno stallo Gmail blocca "Conferma ordine"/"Invia richiesta" fino al timeout della funzione serverless. Fix: `connectionTimeout: 8000, greetingTimeout: 8000, socketTimeout: 15000`. (Risolve anche il finding latency a basso impatto sullo stesso percorso.)

**Input / abuso**
- **Nessuna validazione lunghezza sui campi liberi** (`ordini.ts:51-59`): `inviaRichiestaAction` è POST pubblico senza cap su `nome/email/telefono/note` né rate limiting; ogni chiamata invia due email → flooding/DB bloat. Fix: cap dopo trim (nome ≤200, email ≤254, telefono ≤40, note ≤2000) + rate limit per cart_id/IP.

**Robustezza partial-failure**
- **Bozza AI senza rollback** (`ai-actions.ts:386-392`): insert `prodotto_foto` con errore ignorato dopo upload riuscito → file storage orfani. Fix: controllare `{error}` e rimuovere il file appena caricato (come `actions.ts:404-405`).

**Next.js / SEO**
- **PDP senza `generateMetadata`** + **root senza OpenGraph/`metadataBase`** + **niente `robots.ts`/`sitemap.ts` e pagina ordine indicizzabile** (`prodotti/[slug]/page.tsx:150`, `layout.tsx:20-24`, `ordine/[token]/page.tsx:14`). Per un e-commerce è un difetto reale di discoverability e privacy. Fix: aggiungere `generateMetadata` per il prodotto (wrappare `caricaProdotto` in `cache()` per evitare doppio fetch); aggiungere `metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000')`, `openGraph`, `twitter`; aggiungere `robots.ts`/`sitemap.ts` e `robots:{index:false}` sulla pagina `/ordine/[token]` (idealmente anche `X-Robots-Tag` nel proxy).

**React**
- **Stato selezione PDP persiste tra prodotti** (`ProdottoDettaglio.tsx:78-100`, manca `key` a `page.tsx:194`): navigando client-side da prodotto A a B la selezione colore/taglia/foto resta quella di A. Nessun acquisto di variante errata (la variante è sempre risolta sul prodotto corrente), solo default confuso e galleria stale. Fix: `key={prodotto.slug}` su `<ProdottoDettaglio>` o reset dello stato al cambio `prodotto.id`.

**Dati / SQL**
- **Script di seed distruttivo non protetto** (`scripts/seed-catalogo.mjs:72-80`): DELETE incondizionato di tutti i `prodotti` con service-role, senza `--apply` né guardia su ordini esistenti; su un DB con ordini reali rompe `ordine_righe` (SET NULL) e cancella varianti/carrelli (CASCADE). Fix: gate dietro `--apply`, abort se `count(ordine_righe) > 0`, scoping ai soli slug seed (vedi `consolida-catalogo.mjs`). *(È catalogato high ma è uno script operativo, non runtime di produzione — pericoloso solo se eseguito.)*

**Tipi**
- **Client Supabase non tipizzati** (`supabase/server.ts:16`, `admin.ts:17`, `client.ts:12`): nessun generic `Database`, quindi ogni `.select()` è di fatto `any` e i tipi di dominio derivano da cast `as` non verificati — radice di quasi tutti gli altri buchi di tipo. Fix: `supabase gen types typescript` → `SupabaseClient<Database>`, restringendo i cast ai campi effettivamente selezionati (richiede toccare i call site). In alternativa interim: validazione runtime (zod) ai pochi confini critici (`stato`, `prezzo_cents`).

## Pulizia del codice (quick wins)

Banali (cancellazioni / una riga):
- [ ] Rimuovere export morto `slugConSuffisso()` + JSDoc — `src/lib/gestore/slug.ts:17-24`
- [ ] Rimuovere export morto `emailConfigurata()` + JSDoc — `src/lib/email.ts:15-18`
- [ ] Rimuovere membro union morto `"stock_insufficiente"` — `src/lib/types.ts:94`
- [ ] Togliere `export` da `HEX_FALLBACK` (modulo-privato) — `src/lib/catalogo.ts:104`
- [ ] Aggiungere `colore` al select galleria per matchare `FotoGalleriaRow` (colore mancante a primo render) — `src/app/(gestore)/gestore/(app)/prodotti/[id]/page.tsx:55`
- [ ] Aggiungere `api` al matcher del proxy per evitare `getUser()` su `/api/*` (incl. webhook) — `src/proxy.ts:63-64`
- [ ] Aggiungere guardia env mancante (`url`/`serviceKey`) come gli altri script — `scripts/imposta-taglie.mjs:24-29`
- [ ] Correggere `e` → `è` nelle copy visibili (incl. `api/checkout/route.ts:56` "Il carrello è vuoto") — `checkout/successo/page.tsx:38`, `annullato/page.tsx:33`, `page.tsx:212`, `CartDrawer.tsx:130`, `CarrelloContenuto.tsx:110`, `CartItem.tsx:190,192`
- [ ] Footer: condizionare i link social (pattern `"" = nascosto`) invece di puntare a instagram.com/facebook.com — `src/components/Footer.tsx:46-79`, dati in `src/lib/negozio.ts`
- [ ] Eyebrow `text-lagoon` → `text-sea` su sfondo chiaro — `page.tsx:180`, `ProdottoDettaglio.tsx:152`, `ordine/[token]/page.tsx:110`
- [ ] Sostituire `c.nome!` con un type-predicate nel filter — `src/lib/gestore/ai-actions.ts:229-236`

Effort piccolo/medio:
- [ ] Estrarre helper label-variante in `src/lib/format.ts` e sostituire le 6 copie (attenzione: ordine campi non uniforme tra i siti) — `ordini.ts:33-40,111-118`, `checkout/route.ts:15-26`, `CartItem.tsx:18-27`, `BloccoRichiesta.tsx:30-34`, `ordine/[token]/page.tsx:146-149`
- [ ] Definire `BUCKET_PRODOTTI` e usarlo **solo** sui `storage.from(...)` (non sul nome tabella) — `actions.ts:319,388,392,405,445,548,551`, `ai-actions.ts:316,381,384,403`
- [ ] Estrarre `urlPubblicaFoto(supabase, path)` (getPublicUrl + `?v=`) — `actions.ts:392-393`, `ai-actions.ts:384-385`
- [ ] Estrarre `Campo` + `inputCls` condivisi (3a copia di `inputCls` in `ModuloRichiesta.tsx:13-14`) — `FormProdotto.tsx`, `GeneraDaFoto.tsx`
- [ ] Estrarre `raggruppaCategorie()` + componente opzioni categoria — `FormProdotto.tsx:75-85,177-192`, `GeneraDaFoto.tsx:91-101,299-314`
- [ ] Estrarre primitivo `<Toggle>` (3a copia in `ToggleAttivo.tsx:35-53`) — `FormProdotto.tsx:239-296`
- [ ] Estrarre `caricaCategorie(supabase)` condiviso — `prodotti/nuovo/page.tsx:8-12`, `genera/page.tsx:13-16`, `[id]/page.tsx:37-40`, `(vetrina)/prodotti/[slug]/page.tsx:90`
- [ ] Estrarre `<SelettoreQuantita>` (parametrizzare read-only di `CartItem`) — `BloccoAcquisto.tsx:51-86`, `BloccoRichiesta.tsx:64-93`, `CartItem.tsx:122-147`
- [ ] Estrarre `scripts/_lib.mjs` (`leggiEnv()` + `creaAdmin()` + `BUCKET`) — tutti i 5 script
- [ ] Helper `flagSuRichiesta()` + tipo embedded per togliere i cast `as unknown as` duplicati — `cart.ts:240-244,334-346`
- [ ] Wrapper `withGestore(fn)` o almeno costante condivisa per `"Non autorizzato."` (attenzione a shape di ritorno eterogenee) — `actions.ts` + `ordini-actions.ts` + `ai-actions.ts`
- [ ] Spostare reads puri (`leggiCarrello`/`statoCarrello`) fuori da `"use server"` in `cart-read.ts` — `src/lib/cart.ts`
- [ ] `caricaProdotto` in `cache()` quando si aggiunge `generateMetadata` (evita doppio fetch) — `prodotti/[slug]/page.tsx`

## Note minori

- **PII pagina ordine**: token è l'unica difesa, niente rate limit; impostare `referrer-policy: no-referrer` ed eventuale scadenza token su `creaCheckoutOrdineAction`. L'email **non** è renderizzata nel template attuale (solo `nome` a `:180`), quindi l'esposizione è minore del titolo. — `ordine/[token]/page.tsx`, `ordini.ts:156-217`
- **Stock per-variante leggibile da anon** via PostgREST (`schema.sql:148-156`): leak di inventario a concorrenti. Mitigazione minima `revoke select (stock) on public.varianti from anon;` o flag booleano via view/RPC.
- **RLS carrelli/carrello_righe `USING(true)`** (`schema.sql:162-176`, `init_schema.sql:134-148`): anon può leggere/alterare/cancellare qualsiasi carrello via anon key; protezione solo dal cookie UUID. Hardening: instradare tutto il carrello via `createAdminSupabase()` (come `ordini`) e rimuovere le policy anon.
- **`ordine_righe`/`carrello_righe` FK non indicizzate** (`init_schema.sql:53-64,80-92`): aggiungere indici su `prodotto_id`/`variante_id` (nuova migrazione + `schema.sql`); valore reale principale su `ordine_righe.prodotto_id/variante_id` per i cascade/set-null durante le edit di catalogo.
- **Drift ordine colonne** `schema.sql` vs migrazioni (`schema.sql:30-31,78-97,...`): rigenerare con `supabase db dump` o documentare che è snapshot logico.
- **`checkout/route.ts:104-110`**: insert ordine `in_attesa` con `email` sempre `null` e che fallisce silenziosamente sotto RLS (usa client anon, non admin). Soluzione: passare a `createAdminSupabase()` **o** eliminare l'insert e affidarsi al webhook (autoritativo); aggiungere handler `checkout.session.expired` per le righe orfane.
- **Currency hardcoded `'eur'`** (`checkout/route.ts:63`, `ordini.ts:193`) vs `prodotti.valuta`: aggiungere CHECK `valuta='EUR'` (mono-valuta) — l'override da `valuta` non è praticabile in `ordini.ts` perché `ordine_righe` non ha colonna valuta.
- **Webhook fallback `amount_total ?? 0`** + nessun `ordine_righe` nel ramo direct-buy (`webhook/route.ts:62-78`): record finanziario incompleto; ricostruire le righe da `listLineItems` (dati già disponibili).
- **`svuotaCarrello` ritorna `ok:true` anche se il delete DB fallisce** (`cart.ts:408-429`): loggare l'errore, pulire comunque il cookie, ritornare `esitoVuoto(false,'errore')`.
- **Errori raw Stripe/Anthropic verso il client** (`checkout/route.ts:126-130`, `ordini.ts:223-225`, `ai-actions.ts:250-252`, `webhook:161-177`): `console.error` lato server + messaggio generico; mantenere gli status code distinti nel webhook.
- **AI**: media_type fidato da `file.type` con fallback webp (`ai-actions.ts:126`); `blocco.input as {...}` senza validazione runtime (guardie `Array.isArray`); nessuna istruzione anti prompt-injection nelle immagini; `creaSchedaDaFotoAction` scarta foto non-webp silenziosamente (`376-393`). Tutti contenuti dal try/catch + revisione umana + `attivo=false` → bassa priorità.
- **React minori**: timer `setTimeout` del Toaster mai pulito (`Toaster.tsx:45-52`); quantità non ri-clampata al cambio variante in `BloccoAcquisto` (`21-25,80`); chiavi per indice in `ListaOrdini.tsx:195-202` (non azionabile, manca id su `RigaOrdine`).
- **A11y minori**: mappa Leaflet con `role="img"` fuorviante e nessun fallback no-JS (`MappaNegozio.tsx:81-88`); manca skip-link (`(vetrina)/layout.tsx:22-33`); selettori colore/taglia non raggruppati come radiogroup (`ProdottoDettaglio.tsx:183-283`); errore "Seleziona colore e taglia" irraggiungibile perché il bottone è disabilitato (`BloccoAcquisto.tsx:27,100`); mancano `not-found.tsx`/`error.tsx` storefront on-brand.
- **Tipi (cast non validati)**: `profilo as Profilo` (`auth.ts:44`, coperto da CHECK DB), `stato` → `StatoOrdine` con possibile `STATO_UI[stato]` undefined (usare lookup con fallback), `as unknown as` su relazioni carrello (`cart.ts:135,240-244`), metadata Stripe (`webhook:107-116`) — tutti irraggiungibili in prod grazie a guardie/CHECK, valore solo di manutenibilità.
- **Email**: header injection mitigata da nodemailer + regex (`ordini.ts:126-133`); replyTo cliente-controllato sicuro; `consolida-catalogo.mjs` `.like()` con prefisso costante (no injection). Bollino verde.
- **Vincoli DB**: `ordini.token` senza NOT NULL/CHECK (ordini webhook restano senza token → non visibili su `/ordine/[token]`, ma direct-buy usa `/checkout/successo`); `ordine_righe` senza UNIQUE per riga (lasciare com'è, semantica snapshot). Info.
- **Robustezza carrello**: validazione id assente sulle action pubbliche (parametrizzate + try/catch → info; aggiungere check intero finito su `quantita`, `NaN < 1` sfugge); `esitoCorrente` può mascherare errori di re-read mostrando carrello vuoto come successo; `confermaOrdineAction` ignora il risultato di `inviaEmail`/token mancante (aggiungere `avviso`); `salvaVariantiAction` ignora errore della query di count cascade.

## Piano consigliato

1. **Prima — perimetro pagamenti/ordini (critico, richiede cura e test).** Riscrivere il finalize del webhook: RPC atomica per il decremento + flag `stock_scalato` idempotente + gate su `payment_status` + cattura degli `{error}`. Contestualmente aggiungere le guardie di transizione di stato in `ordini-actions.ts` (e allineare il decremento stock di `segnaPagatoOrdineAction`) per chiudere il doppio addebito. Questi due item condividono il dominio "stato ordine + stock" e vanno testati insieme (concorrenza, retry Stripe, conferma manuale).
2. **Secondo — sicurezza/robustezza a basso rischio applicabili subito.** Timeout SMTP; controllo errori sulle scritture carrello; messaggi di errore generici verso client + `console.error`; cap di lunghezza + rate limit su `inviaRichiestaAction`; `--apply` + guardia ordini su `seed-catalogo.mjs`; matcher proxy per `/api/*`; `robots:{index:false}` sulla pagina ordine. Mix carrello su-richiesta e blocco `+` per articoli su-richiesta (entrambi dipendono dall'aggiungere il flag in `leggiCarrello`, da fare in un colpo).
3. **Terzo — accessibilità e SEO.** Token colore errore `--coral-ink` + eyebrow `text-sea` (batch, basso rischio); `generateMetadata` PDP + OpenGraph/`metadataBase` root + `robots.ts`/`sitemap.ts`; `key` su `<ProdottoDettaglio>`.
4. **Quarto — debito strutturale e pulizia.** Generare i tipi Supabase (`SupabaseClient<Database>`) e restringere i cast; poi applicare in batch tutta la sezione "Pulizia del codice".

**Batchabili subito senza rischio**: tutte le voci "banali" della sezione pulizia (dead code, accenti, token colori, export, indici DB, guardia env script, link footer). **Richiedono cura/test**: tutto il punto 1, il rate limiting, la migrazione ai client Supabase tipizzati (tocca molti call site), e l'hardening RLS del carrello (cambia il trust boundary).