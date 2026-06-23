import { requireGestore } from "@/lib/gestore/auth";
import FormProdotto from "@/components/gestore/FormProdotto";
import type { Categoria } from "@/lib/types";

export default async function NuovoProdottoPage() {
  const { supabase } = await requireGestore();

  const { data: catData } = await supabase
    .from("categorie")
    .select("id, slug, nome, parent_id, ordine")
    .order("ordine", { ascending: true });
  const categorie = (catData as Categoria[] | null) ?? [];

  return (
    <div>
      <h1 className="mx-auto mb-5 max-w-xl text-xl font-semibold text-foreground">
        Nuovo prodotto
      </h1>
      <FormProdotto categorie={categorie} />
    </div>
  );
}
