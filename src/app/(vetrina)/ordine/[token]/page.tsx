// Pagina pubblica di stato/pagamento di un ordine: /ordine/[token].
// Il token (UUID imprevedibile) e l'unica chiave d'accesso: lettura server-side
// con admin client (gli ordini non hanno policy anon). Mostra lo stato e, se
// confermato, il bottone "Paga ora".

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import PulsantePaga from "@/components/prodotto/PulsantePaga";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { formatPrezzo } from "@/lib/format";
import { isStatoOrdine, type StatoOrdine } from "@/lib/types";

export const dynamic = "force-dynamic";

// Pagina gated da token con PII dell'ordine: mai indicizzata.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

interface RigaOrdine {
  nome_prodotto: string;
  taglia: string | null;
  colore: string | null;
  prezzo_cents: number;
  quantita: number;
}
interface OrdineDettaglio {
  id: string;
  stato: StatoOrdine;
  totale_cents: number;
  nome: string | null;
  email: string | null;
  creato_il: string;
  righe: RigaOrdine[];
}

async function caricaOrdine(token: string): Promise<OrdineDettaglio | null> {
  try {
    const admin = createAdminSupabase();
    const { data, error } = await admin
      .from("ordini")
      .select(
        "id, stato, totale_cents, nome, email, creato_il, ordine_righe(nome_prodotto, taglia, colore, prezzo_cents, quantita)",
      )
      .eq("token", token)
      .maybeSingle();
    // Narrow runtime di `stato` (dal DB arriva come string): uno stato ignoto
    // -> trattato come ordine non trovato, niente STATO_UI[undefined].
    if (error || !data || !isStatoOrdine(data.stato)) return null;
    return {
      id: data.id,
      stato: data.stato,
      totale_cents: data.totale_cents,
      nome: data.nome,
      email: data.email,
      creato_il: data.creato_il,
      righe: (data.ordine_righe as RigaOrdine[] | null) ?? [],
    };
  } catch {
    return null;
  }
}

const STATO_UI: Record<
  StatoOrdine,
  { titolo: string; testo: string; chip: string; chipCls: string }
> = {
  in_attesa: {
    titolo: "Richiesta ricevuta",
    testo:
      "Stiamo verificando la disponibilità di tutti gli articoli. Ti ricontattiamo a breve: appena confermiamo potrai pagare da questa pagina.",
    chip: "In attesa di conferma",
    chipCls: "bg-sun/30 text-[#8a6500]",
  },
  confermato: {
    titolo: "Disponibile!",
    testo:
      "Abbiamo confermato la disponibilità. Completa il pagamento in sicurezza con Stripe per finalizzare l'ordine.",
    chip: "Da pagare",
    chipCls: "bg-lagoon/15 text-sea",
  },
  pagato: {
    titolo: "Ordine pagato",
    testo:
      "Grazie! Abbiamo ricevuto il pagamento. Ti contatteremo per la consegna o il ritiro.",
    chip: "Pagato",
    chipCls: "bg-sea/15 text-sea",
  },
  annullato: {
    titolo: "Richiesta annullata",
    testo:
      "Questa richiesta è stata annullata. Se pensi sia un errore, scrivici pure: troviamo una soluzione.",
    chip: "Annullato",
    chipCls: "bg-coral/15 text-coral",
  },
};

export default async function PaginaOrdine({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ pagato?: string }>;
}) {
  const { token } = await params;
  const { pagato } = await searchParams;
  const ordine = await caricaOrdine(token);
  if (!ordine) notFound();

  const ui = STATO_UI[ordine.stato];
  // Reduce dal pagamento Stripe: il webhook potrebbe non aver ancora aggiornato.
  const inElaborazione = pagato === "1" && ordine.stato !== "pagato";

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-12 sm:px-6">
      <p className="font-display text-sm font-bold uppercase tracking-wide text-sea">
        Il tuo ordine
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <h1 className="font-display text-3xl font-extrabold tracking-tight text-foreground">
          {ui.titolo}
        </h1>
        <span
          className={`rounded-full px-3 py-1 text-xs font-bold ${ui.chipCls}`}
        >
          {ui.chip}
        </span>
      </div>

      {inElaborazione ? (
        <p className="mt-4 rounded-2xl bg-sun/15 px-4 py-3 text-sm text-[#8a6500] ring-1 ring-sun/40">
          Stiamo registrando il pagamento… aggiorna la pagina tra qualche
          secondo.
        </p>
      ) : (
        <p className="mt-4 max-w-prose leading-relaxed text-muted">{ui.testo}</p>
      )}

      {ordine.stato === "confermato" && (
        <div className="mt-6">
          <PulsantePaga token={token} />
        </div>
      )}

      {/* Articoli */}
      <section className="mt-8 rounded-3xl bg-surface p-6 shadow-soft ring-1 ring-line">
        <h2 className="font-display text-base font-extrabold text-foreground">
          Articoli richiesti
        </h2>
        <ul className="mt-4 divide-y divide-line">
          {ordine.righe.map((r, i) => {
            const dettagli = [
              r.colore,
              r.taglia ? `Taglia ${r.taglia}` : null,
            ].filter(Boolean);
            return (
              <li
                key={i}
                className="flex items-start justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-display text-sm font-bold text-foreground">
                    {r.nome_prodotto}
                  </p>
                  {dettagli.length > 0 && (
                    <p className="text-xs text-muted">{dettagli.join(" · ")}</p>
                  )}
                  <p className="text-xs text-muted">Quantità: {r.quantita}</p>
                </div>
                <span className="shrink-0 font-display text-sm font-bold tabular-nums text-foreground">
                  {formatPrezzo(r.prezzo_cents * r.quantita)}
                </span>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
          <span className="font-display font-bold text-foreground">
            Totale stimato
          </span>
          <span className="font-display text-xl font-extrabold text-sea">
            {formatPrezzo(ordine.totale_cents)}
          </span>
        </div>
        <p className="mt-2 text-xs text-muted">
          Spedizione/ritiro da concordare. Intestato a {ordine.nome ?? "—"}.
        </p>
      </section>

      <div className="mt-6 text-center">
        <Link
          href="/"
          className="text-sm font-medium text-sea underline-offset-2 transition-colors hover:text-lagoon hover:underline"
        >
          Torna alla vetrina
        </Link>
      </div>
    </main>
  );
}
