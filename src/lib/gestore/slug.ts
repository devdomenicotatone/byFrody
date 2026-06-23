// Generazione di slug url-friendly per i prodotti (area gestore).

/**
 * Converte un testo in uno slug: minuscolo, senza accenti, parole unite da "-".
 * Es. slugify("T-shirt Blu Notte") => "t-shirt-blu-notte".
 */
export function slugify(testo: string): string {
  return testo
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // rimuove i diacritici (accenti)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-") // non-alfanumerico => "-"
    .replace(/^-+|-+$/g, ""); // niente "-" iniziali/finali
}
