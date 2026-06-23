-- ============================================================================
-- Borracci Anna - Categorie + Galleria foto prodotto
-- ----------------------------------------------------------------------------
-- Migration idempotente. Aggiunge:
--   1) tabella `categorie` (lista gestibile dal pannello) + seed Polo/Coreane;
--   2) colonna `prodotti.categoria_id` (FK -> categorie, set null on delete);
--   3) tabella `prodotto_foto` (galleria multi-foto, foto associabile a una
--      variante colore) + RLS coerente con `varianti`.
-- NON modifica le policy esistenti: aggiunge solo nuovi oggetti e policy.
-- ============================================================================

-- 1. CATEGORIE ---------------------------------------------------------------
create table if not exists public.categorie (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  nome       text not null,
  ordine     integer not null default 0,
  creato_il  timestamptz not null default now()
);
comment on table public.categorie is
  'Categorie di catalogo, gestibili dal pannello gestore. Ogni prodotto ne ha al piu una.';

create index if not exists idx_categorie_ordine on public.categorie (ordine);

alter table public.categorie enable row level security;

-- Lettura pubblica (tassonomia non sensibile, usata in vetrina per i filtri).
drop policy if exists "categorie_lettura_pubblica" on public.categorie;
create policy "categorie_lettura_pubblica"
  on public.categorie for select
  using ( true );

-- Scrittura riservata al gestore.
drop policy if exists "categorie_insert_gestore" on public.categorie;
create policy "categorie_insert_gestore"
  on public.categorie for insert to authenticated
  with check ( public.is_gestore() );

drop policy if exists "categorie_update_gestore" on public.categorie;
create policy "categorie_update_gestore"
  on public.categorie for update to authenticated
  using ( public.is_gestore() ) with check ( public.is_gestore() );

drop policy if exists "categorie_delete_gestore" on public.categorie;
create policy "categorie_delete_gestore"
  on public.categorie for delete to authenticated
  using ( public.is_gestore() );

-- Seed iniziale (idempotente per slug).
insert into public.categorie (slug, nome, ordine)
values
  ('polo',    'Polo',    1),
  ('coreane', 'Coreane', 2)
on conflict (slug) do nothing;

-- 2. PRODOTTI.categoria_id ---------------------------------------------------
-- on delete set null: eliminare una categoria non cancella i prodotti, li
-- lascia "senza categoria".
alter table public.prodotti
  add column if not exists categoria_id uuid
    references public.categorie (id) on delete set null;

create index if not exists idx_prodotti_categoria on public.prodotti (categoria_id);

-- 3. PRODOTTO_FOTO (galleria) ------------------------------------------------
-- Galleria multi-foto. `variante_id` opzionale: se valorizzato, la foto
-- rappresenta quel colore (on delete set null: cancellando la variante la foto
-- resta come foto generica del prodotto invece di sparire). La copertina resta
-- `prodotti.immagine_url` (retro-compatibilita con vetrina/carrello/OG image).
create table if not exists public.prodotto_foto (
  id           uuid primary key default gen_random_uuid(),
  prodotto_id  uuid not null references public.prodotti (id) on delete cascade,
  variante_id  uuid references public.varianti (id) on delete set null,
  url          text not null,
  ordine       integer not null default 0,
  creato_il    timestamptz not null default now()
);
comment on table public.prodotto_foto is
  'Galleria foto del prodotto. variante_id opzionale = foto del colore. La copertina resta prodotti.immagine_url.';

create index if not exists idx_prodotto_foto_prodotto
  on public.prodotto_foto (prodotto_id, ordine);
create index if not exists idx_prodotto_foto_variante
  on public.prodotto_foto (variante_id);

alter table public.prodotto_foto enable row level security;

-- Lettura pubblica solo se il prodotto e attivo (stessa logica di varianti).
drop policy if exists "prodotto_foto_lettura_pubblica" on public.prodotto_foto;
create policy "prodotto_foto_lettura_pubblica"
  on public.prodotto_foto for select
  using (
    exists (
      select 1 from public.prodotti p
      where p.id = prodotto_foto.prodotto_id and p.attivo = true
    )
  );

-- Il gestore legge anche le foto dei prodotti non attivi (bozze).
drop policy if exists "prodotto_foto_lettura_gestore" on public.prodotto_foto;
create policy "prodotto_foto_lettura_gestore"
  on public.prodotto_foto for select to authenticated
  using ( public.is_gestore() );

drop policy if exists "prodotto_foto_insert_gestore" on public.prodotto_foto;
create policy "prodotto_foto_insert_gestore"
  on public.prodotto_foto for insert to authenticated
  with check ( public.is_gestore() );

drop policy if exists "prodotto_foto_update_gestore" on public.prodotto_foto;
create policy "prodotto_foto_update_gestore"
  on public.prodotto_foto for update to authenticated
  using ( public.is_gestore() ) with check ( public.is_gestore() );

drop policy if exists "prodotto_foto_delete_gestore" on public.prodotto_foto;
create policy "prodotto_foto_delete_gestore"
  on public.prodotto_foto for delete to authenticated
  using ( public.is_gestore() );
