"use client";

// Bottone "Paga ora" sulla pagina /ordine/[token] (solo ordini confermati).
// Crea la Checkout Session Stripe on-demand e reindirizza al pagamento.

import { useState, useTransition } from "react";

import { creaCheckoutOrdineAction } from "@/lib/ordini";

export default function PulsantePaga({ token }: { token: string }) {
  const [inCorso, startTransition] = useTransition();
  const [errore, setErrore] = useState<string | null>(null);

  function paga() {
    setErrore(null);
    startTransition(async () => {
      const esito = await creaCheckoutOrdineAction(token);
      if (esito.ok && esito.url) {
        window.location.href = esito.url;
        return;
      }
      setErrore(esito.error ?? "Impossibile avviare il pagamento.");
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={paga}
        disabled={inCorso}
        className="flex h-12 w-full items-center justify-center gap-2 rounded-full bg-coral px-6 font-display font-bold text-white shadow-coral transition-transform hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-5 w-5"
        >
          <rect x="2" y="5" width="20" height="14" rx="2" />
          <path d="M2 10h20" />
        </svg>
        {inCorso ? "Avvio pagamento…" : "Paga ora"}
      </button>
      {errore && (
        <p role="alert" className="text-sm font-semibold text-coral">
          {errore}
        </p>
      )}
    </div>
  );
}
