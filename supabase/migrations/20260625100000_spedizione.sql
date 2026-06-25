-- ============================================================================
-- Borracci Anna — Spedizione: costo e indirizzo sull'ordine
-- ----------------------------------------------------------------------------
-- Finora la spedizione era solo marketing (barra "spedizione gratis"): nessuna
-- tariffa veniva addebitata e l'indirizzo raccolto da Stripe non veniva salvato.
-- Questa migration:
--   1) aggiunge costo_spedizione_cents e spedizione_indirizzo su public.ordini;
--   2) estende finalizza_ordine_pagato per persistere il costo di spedizione
--      (da session.shipping_cost) e l'indirizzo, nella STESSA transazione
--      atomica/idempotente della finalizzazione, e per allineare totale_cents
--      a quanto realmente incassato (amount_total = merce + spedizione).
-- ============================================================================

-- Costo spedizione: NULL finche ignoto (pre-pagamento / richiesta non confermata).
alter table public.ordini
  add column if not exists costo_spedizione_cents integer
    check (costo_spedizione_cents is null or costo_spedizione_cents >= 0);

-- Indirizzo di spedizione scelto su Stripe (nome + address), salvato dal webhook.
alter table public.ordini
  add column if not exists spedizione_indirizzo jsonb;

-- ----------------------------------------------------------------------------
-- finalizza_ordine_pagato: nuova firma con costo spedizione + indirizzo.
-- La firma cambia (parametri aggiunti): CREATE OR REPLACE non puo cambiare il
-- numero di argomenti, quindi si fa DROP esplicito della vecchia versione prima
-- di ricrearla. I nuovi parametri hanno default NULL per retro-compatibilita.
-- ----------------------------------------------------------------------------
drop function if exists public.finalizza_ordine_pagato(text, text, integer, jsonb);

create or replace function public.finalizza_ordine_pagato(
  p_session_id     text,
  p_email          text,
  p_total          integer,
  p_righe          jsonb,
  p_shipping_cents integer default null,
  p_indirizzo      jsonb   default null
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

  -- Nessun ordine pre-creato (fallback direct-buy): lo creiamo gia "pagato"
  -- includendo subito costo spedizione e indirizzo.
  if not found then
    insert into public.ordini (
      stato, totale_cents, email, stripe_session_id, stock_scalato,
      costo_spedizione_cents, spedizione_indirizzo
    )
    values (
      'pagato', coalesce(p_total, 0), p_email, p_session_id, false,
      p_shipping_cents, p_indirizzo
    )
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

  -- Decremento atomico per ogni riga (greatest = mai sotto zero).
  for v_riga in select * from jsonb_array_elements(coalesce(p_righe, '[]'::jsonb))
  loop
    update public.varianti
       set stock = greatest(0, stock - greatest(0, coalesce((v_riga->>'qta')::int, 0)))
     where sku = (v_riga->>'sku');
  end loop;

  -- Marca pagato + email + flag idempotente; allinea il totale a quanto incassato
  -- (amount_total include la spedizione) e salva costo spedizione + indirizzo.
  -- coalesce: non azzerare valori gia presenti se un parametro arriva null.
  update public.ordini
     set stato = 'pagato',
         email = coalesce(p_email, email),
         stock_scalato = true,
         totale_cents = coalesce(p_total, totale_cents),
         costo_spedizione_cents = coalesce(p_shipping_cents, costo_spedizione_cents),
         spedizione_indirizzo = coalesce(p_indirizzo, spedizione_indirizzo)
   where id = v_ordine.id;
end;
$$;

revoke all on function public.finalizza_ordine_pagato(text, text, integer, jsonb, integer, jsonb) from public;
grant execute on function public.finalizza_ordine_pagato(text, text, integer, jsonb, integer, jsonb) to service_role;
