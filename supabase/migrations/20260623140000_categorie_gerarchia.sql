-- ============================================================================
-- Borracci Anna - Categorie gerarchiche (macro UOMO/DONNA sopra Polo/Coreane)
-- ----------------------------------------------------------------------------
-- Migration idempotente. Aggiunge `categorie.parent_id` (auto-riferimento) per
-- una gerarchia a 2 livelli, crea le macro UOMO e DONNA, e sposta le attuali
-- Polo/Coreane sotto UOMO. Additiva: non rimuove nulla.
-- ============================================================================

-- 1. parent_id (categoria padre; set null on delete -> i figli diventano root).
alter table public.categorie
  add column if not exists parent_id uuid
    references public.categorie (id) on delete set null;

create index if not exists idx_categorie_parent on public.categorie (parent_id);

-- 2. Macro categorie (root: parent_id null). Idempotente per slug.
insert into public.categorie (slug, nome, ordine)
values
  ('uomo',  'Uomo',  1),
  ('donna', 'Donna', 2)
on conflict (slug) do nothing;

-- 3. Sposta Polo e Coreane sotto UOMO (solo se ancora senza genitore).
update public.categorie
  set parent_id = (select id from public.categorie where slug = 'uomo')
  where slug in ('polo', 'coreane')
    and parent_id is null;
