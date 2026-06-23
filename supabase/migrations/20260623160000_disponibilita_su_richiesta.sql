-- ============================================================================
-- Borracci Anna - "Disponibilita su richiesta" + foto associata al colore
-- ----------------------------------------------------------------------------
-- Migration idempotente e additiva.
--
--   1) prodotti.disponibilita_su_richiesta (default TRUE): il negozio non tiene
--      il magazzino in tempo reale; il cliente sceglie colore+taglia e CONTATTA
--      il negozio ("Scrivici per la disponibilita"). Default TRUE => tutti i
--      prodotti esistenti passano subito in questa modalita.
--   2) prodotto_foto.colore: la foto segue un COLORE (testo), non piu una singola
--      variante. Cosi resta legata al colore anche quando le varianti vengono
--      rigenerate passando da "solo colore" a "colore x taglia". `variante_id`
--      resta per compatibilita ma non e piu il riferimento usato.
--      Backfill: colore = colore della variante attualmente collegata.
-- ============================================================================

-- 1. Disponibilita su richiesta (magazzino non in tempo reale). -------------
alter table public.prodotti
  add column if not exists disponibilita_su_richiesta boolean not null default true;

-- 2. Colore della foto di galleria. -----------------------------------------
alter table public.prodotto_foto
  add column if not exists colore text;

-- Backfill: eredita il colore dalla variante collegata (solo dove non gia impostato).
update public.prodotto_foto pf
  set colore = v.colore
  from public.varianti v
  where pf.variante_id = v.id
    and pf.colore is null
    and v.colore is not null;
