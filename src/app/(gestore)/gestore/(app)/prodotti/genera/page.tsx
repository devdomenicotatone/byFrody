import { requireGestore } from "@/lib/gestore/auth";
import GeneraDaFoto from "@/components/gestore/GeneraDaFoto";
import type { Categoria } from "@/lib/types";

// La generazione AI (vision) puo durare alcune decine di secondi: alziamo il
// limite della funzione serverless (la Server Action gira in questa route).
export const maxDuration = 60;

export default async function GeneraSchedaPage() {
  const { supabase } = await requireGestore();

  const { data } = await supabase
    .from("categorie")
    .select("id, slug, nome, parent_id, ordine")
    .order("ordine", { ascending: true });
  const categorie = (data as Categoria[] | null) ?? [];

  return (
    <div>
      <h1 className="mx-auto mb-1 max-w-xl text-xl font-semibold text-foreground">
        ✨ Genera scheda da foto
      </h1>
      <p className="mx-auto mb-6 max-w-xl text-sm text-muted">
        Carica le foto del prodotto (anche in piu colori) e dell&apos;etichetta:
        l&apos;AI compila una bozza con descrizione, composizione, lavaggio e
        varianti colore. La rivedi e la crei.
      </p>
      <GeneraDaFoto categorie={categorie} />
    </div>
  );
}
