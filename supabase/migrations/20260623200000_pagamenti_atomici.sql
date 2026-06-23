-- ============================================================================
-- Borracci Anna — Finalizzazione ordini atomica e idempotente
-- ----------------------------------------------------------------------------
-- Chiude i rischi sul percorso pagamenti emersi in audit:
--   1) decremento stock non atomico (read-modify-write -> lost update / oversell
--      sotto consegne webhook concorrenti o retry);
--   2) finalizzazione non idempotente: un retry di Stripe dopo un errore parziale
--      vedeva l'ordine gia "pagato" e NON scalava piu lo stock.
-- Soluzione: il decremento + il cambio stato avvengono in UNA transazione, con
-- lock di riga sull'ordine. Le consegne concorrenti/ritentate dello stesso evento
-- si serializzano e lo stock viene scalato una sola volta (flag stock_scalato).
-- ============================================================================

-- Flag idempotente: true quando lo stock dell'ordine e gia stato scalato.
alter table public.ordini
  add column if not exists stock_scalato boolean not null default false;

-- DB esistenti: gli ordini gia "pagato" col vecchio codice hanno gia scalato lo
-- stock -> li marchiamo, cosi un eventuale retry tardivo non riscala nulla.
update public.ordini set stock_scalato = true
  where stato = 'pagato' and stock_scalato = false;

-- ----------------------------------------------------------------------------
-- finalizza_ordine_pagato: usata dal webhook Stripe (checkout completato /
-- async_payment_succeeded). Riceve le righe (sku, qta) ricavate dalle line item
-- della sessione. Atomica + idempotente. SECURITY DEFINER: opera a prescindere
-- dalla RLS (il chiamante e comunque il service_role del webhook).
-- ----------------------------------------------------------------------------
create or replace function public.finalizza_ordine_pagato(
  p_session_id text,
  p_email      text,
  p_total      integer,
  p_righe      jsonb
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_ordine public.ordini%rowtype;
  v_riga   jsonb;
begin
  -- Lock della riga ordine: serializza le finalizzazioni concorrenti.
  select * into v_ordine
    from public.ordini
   where stripe_session_id = p_session_id
   for update;

  -- Nessun ordine pre-creato (fallback direct-buy): lo creiamo gia "pagato".
  if not found then
    insert into public.ordini (stato, totale_cents, email, stripe_session_id, stock_scalato)
    values ('pagato', coalesce(p_total, 0), p_email, p_session_id, false)
    on conflict (stripe_session_id) do nothing
    returning * into v_ordine;
    -- Race: un'altra consegna ha appena inserito -> rileggi con lock.
    if not found then
      select * into v_ordine from public.ordini
       where stripe_session_id = p_session_id for update;
    end if;
  end if;

  -- Idempotenza: gia finalizzato (pagato + stock scalato) -> niente da fare.
  if v_ordine.stato = 'pagato' and v_ordine.stock_scalato then
    return;
  end if;

  -- Decremento atomico per ogni riga (greatest = mai sotto zero). L'intera
  -- funzione e una sola transazione: o tutto committa, o tutto fa rollback.
  for v_riga in select * from jsonb_array_elements(coalesce(p_righe, '[]'::jsonb))
  loop
    update public.varianti
       set stock = greatest(0, stock - greatest(0, coalesce((v_riga->>'qta')::int, 0)))
     where sku = (v_riga->>'sku');
  end loop;

  -- Marca pagato + email + flag idempotente, nella stessa transazione.
  update public.ordini
     set stato = 'pagato',
         email = coalesce(p_email, email),
         stock_scalato = true
   where id = v_ordine.id;
end;
$$;

revoke all on function public.finalizza_ordine_pagato(text, text, integer, jsonb) from public;
grant execute on function public.finalizza_ordine_pagato(text, text, integer, jsonb) to service_role;

-- ----------------------------------------------------------------------------
-- segna_ordine_pagato_manuale: pagamento "in negozio" dal pannello gestore.
-- Allinea il comportamento a quello di Stripe (scala lo stock UNA volta) e
-- impedisce transizioni illegali. Decrementa dalle righe d'ordine (snapshot).
-- ----------------------------------------------------------------------------
create or replace function public.segna_ordine_pagato_manuale(
  p_ordine_id uuid
) returns void
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_ordine public.ordini%rowtype;
begin
  select * into v_ordine
    from public.ordini
   where id = p_ordine_id
   for update;

  if not found then
    raise exception 'Ordine inesistente.';
  end if;

  -- Idempotenza.
  if v_ordine.stato = 'pagato' then
    return;
  end if;

  -- Solo da una richiesta in attesa o confermata si puo passare a pagato.
  if v_ordine.stato not in ('in_attesa', 'confermato') then
    raise exception 'Transizione non consentita da % a pagato.', v_ordine.stato;
  end if;

  -- Decremento atomico aggregato per variante (somma quantita per variante).
  if not v_ordine.stock_scalato then
    update public.varianti v
       set stock = greatest(0, v.stock - agg.qta)
      from (
        select variante_id, sum(quantita)::int as qta
          from public.ordine_righe
         where ordine_id = p_ordine_id and variante_id is not null
         group by variante_id
      ) agg
     where agg.variante_id = v.id;
  end if;

  update public.ordini
     set stato = 'pagato',
         stock_scalato = true
   where id = v_ordine.id;
end;
$$;

revoke all on function public.segna_ordine_pagato_manuale(uuid) from public;
grant execute on function public.segna_ordine_pagato_manuale(uuid) to service_role;

-- ----------------------------------------------------------------------------
-- Indici sulle FK non indicizzate: velocizzano i cascade/set-null durante le
-- modifiche di catalogo e le query per variante.
-- ----------------------------------------------------------------------------
create index if not exists idx_ordine_righe_prodotto on public.ordine_righe (prodotto_id);
create index if not exists idx_ordine_righe_variante on public.ordine_righe (variante_id);
create index if not exists idx_carrello_righe_prodotto on public.carrello_righe (prodotto_id);
create index if not exists idx_carrello_righe_variante on public.carrello_righe (variante_id);
