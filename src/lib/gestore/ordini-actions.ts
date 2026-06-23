"use server";

// Server Actions del pannello ordini (area gestore).
// Auth: verifySession() (solo gestore). Dati: admin client (service role), perche
// `ordini` non ha policy anon/auth — la barriera e l'auth-gate qui sopra.

import { revalidatePath } from "next/cache";

import { verifySession } from "@/lib/gestore/auth";
import { createAdminSupabase } from "@/lib/supabase/admin";
import { inviaEmail } from "@/lib/email";
import { NEGOZIO } from "@/lib/negozio";

export interface EsitoOrdine {
  ok: boolean;
  error?: string;
}

async function aggiornaStato(
  id: string,
  patch: Record<string, unknown>,
): Promise<EsitoOrdine> {
  const sessione = await verifySession();
  if (!sessione) return { ok: false, error: "Non autorizzato." };

  try {
    const admin = createAdminSupabase();
    const { error } = await admin.from("ordini").update(patch).eq("id", id);
    if (error) return { ok: false, error: error.message };

    revalidatePath("/gestore/ordini");
    return { ok: true };
  } catch {
    return { ok: false, error: "Errore di rete. Riprova." };
  }
}

/**
 * Conferma la disponibilita: l'ordine passa a "confermato" e diventa pagabile.
 * Notifica il cliente via email col link di pagamento (best effort).
 */
export async function confermaOrdineAction(id: string): Promise<EsitoOrdine> {
  const sessione = await verifySession();
  if (!sessione) return { ok: false, error: "Non autorizzato." };

  try {
    const admin = createAdminSupabase();
    const { data: ordine, error } = await admin
      .from("ordini")
      .update({ stato: "confermato", confermato_il: new Date().toISOString() })
      .eq("id", id)
      .select("email, nome, token")
      .single();
    if (error) return { ok: false, error: error.message };

    revalidatePath("/gestore/ordini");

    if (ordine?.email && ordine.token) {
      const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "";
      await inviaEmail({
        to: ordine.email,
        subject: "La tua richiesta è disponibile — completa l'ordine · Borracci Anna",
        text: `Ciao ${ordine.nome ?? ""},\n\nbuone notizie: gli articoli della tua richiesta sono disponibili! Completa il pagamento in sicurezza da questa pagina:\n\n${siteUrl}/ordine/${ordine.token}\n\nA presto,\nBorracci Anna — ${NEGOZIO.indirizzoCompleto}`,
      });
    }
    return { ok: true };
  } catch {
    return { ok: false, error: "Errore di rete. Riprova." };
  }
}

/** Rifiuta/annulla l'ordine. */
export async function annullaOrdineAction(id: string): Promise<EsitoOrdine> {
  return aggiornaStato(id, { stato: "annullato" });
}

/** Segna pagato manualmente (es. pagamento in negozio). */
export async function segnaPagatoOrdineAction(id: string): Promise<EsitoOrdine> {
  return aggiornaStato(id, { stato: "pagato" });
}
