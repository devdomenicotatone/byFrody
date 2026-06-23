-- ============================================================================
-- Borracci Anna - Ordini "a pagamento differito" (richiesta -> conferma -> incasso)
-- ----------------------------------------------------------------------------
-- Migration idempotente e additiva. Estende `ordini` per il flusso:
--   in_attesa  -> richiesta inviata dal cliente, da confermare dal gestore
--   confermato -> gestore ha confermato la disponibilita, in attesa di pagamento
--   pagato     -> pagato (webhook Stripe)
--   annullato  -> rifiutato / annullato
--
-- Aggiunge i dati del cliente (nome/telefono/note) e un `token` segreto per la
-- pagina pubblica di stato/pagamento /ordine/[token]. Gli ordini restano
-- accessibili SOLO via service role (nessuna policy anon): creazione, lettura
-- per token e pannello gestore passano dal server (admin client).
-- ============================================================================

-- 1. Stato: aggiunge 'confermato' al vincolo (ricreato per nome convenzionale).
alter table public.ordini drop constraint if exists ordini_stato_check;
alter table public.ordini
  add constraint ordini_stato_check
  check (stato in ('in_attesa', 'confermato', 'pagato', 'annullato'));

-- 2. Dati cliente + tracciamento conferma.
alter table public.ordini add column if not exists nome text;
alter table public.ordini add column if not exists telefono text;
alter table public.ordini add column if not exists note text;
alter table public.ordini add column if not exists confermato_il timestamptz;

-- 3. Token segreto per la pagina pubblica /ordine/[token]. Nullable (gli ordini
--    vecchi non ce l'hanno); univoco quando presente.
alter table public.ordini add column if not exists token text;
create unique index if not exists idx_ordini_token on public.ordini (token);

-- 4. Snapshot taglia/colore sulle righe d'ordine (per mostrarle nel pannello e
--    nella pagina stato anche se la variante viene poi modificata/eliminata).
alter table public.ordine_righe add column if not exists taglia text;
alter table public.ordine_righe add column if not exists colore text;
