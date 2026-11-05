// Phase 1: candidate matching utility for later EPUB and shelf-photo recognition.
// Recognition/OCR will feed this module; this file does NOT perform image recognition.
// No DB writes: caller must audit a snapshot and provide Undo before applying updates.

export function normalizeTitle(value = "") {
  return String(value)
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/^\s*(?:z[-\s]?library|libgen)\s*[-_:|]\s*/i, "")
    .replace(/\s*(?:\[\s*(?:z[-\s]?library|libgen)\s*\]|\(\s*(?:z[-\s]?library|libgen)\s*\))\s*/gi, " ")
    .replace(/\.epub$/i, "")
    .replace(/\s*\(\s*\d+\s*\)(?=\s*$)/g, " ")
    .replace(/[^a-z\d]+/gi, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeAuthor(value = "") {
  return String(value)
    .normalize("NFKC")
    .replace(/[^a-z\d]+/gi, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function textSimilarity(a, b) {
  const x = normalizeTitle(a), y = normalizeTitle(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const xTokens = new Set(x.split(" "));
  const yTokens = new Set(y.split(" "));
  let shared = 0;
  for (const token of xTokens) if (yTokens.has(token)) shared++;
  return shared / new Set([...xTokens, ...yTokens]).size;
}

/**
 * Input candidate:
 *   {title, author?, isbn?, editionVendor?, editionName?}
 * Library rows:
 *   {id, title, author, isbn?, editions?:[{id,isbn?,vendor?,edition_name?}]}
 * No false promise: near matches only enter review; an exact ISBN is a strong
 * edition match, but ISBN alone never proves a signed or specific physical copy.
 */
export function suggestShelfMatches(candidate, books, {limit=5}={}) {
  const matches = [];
  const title = normalizeTitle(candidate.title);
  const author = normalizeAuthor(candidate.author);
  const isbn = String(candidate.isbn || "").replace(/[^0-9X]/gi, "");
  const vendor = normalizeTitle(candidate.editionVendor || "");
  for (const book of books || []) {
    const titleScore = textSimilarity(title, book.title);
    const authorMatch = !!author && author === normalizeAuthor(book.author);
    const editions = book.editions || [];
    const editionMatch = editions.find(e => isbn && String(e.isbn || "").replace(/[^0-9X]/gi, "") === isbn);
    const vendorEdition = editions.find(e => vendor && normalizeTitle(e.vendor || "") === vendor);
    const score = editionMatch ? 1 : Math.min(0.99, titleScore*0.80 + (authorMatch ? 0.19 : 0));
    if (!editionMatch && score < 0.40) continue;
    const exactWork = titleScore === 1 && authorMatch;
    // Auto-link to the canonical BOOK when both title and author are exact,
    // or ISBN matches an existing edition; never auto-select an actual copy.
    const classification = editionMatch || exactWork ? "safe_book_match" : "needs_review";
    matches.push({
      bookId: book.id,
      editionId: editionMatch?.id ?? (vendorEdition && exactWork ? vendorEdition.id : null),
      score: Number(score.toFixed(3)),
      classification,
      evidence: {
        titleSimilarity: Number(titleScore.toFixed(3)),
        authorExact: authorMatch,
        isbnExact: Boolean(editionMatch),
        vendorEditionMatch: Boolean(vendorEdition && exactWork)
      }
    });
  }
  return matches.sort((a,b)=>b.score-a.score).slice(0,Math.max(1,limit));
}

/**
 * Suggestion action, never an irreversible overwrite:
 * - A book match means link the shelf detection to the existing book.
 * - Where a unique physical copy has been resolved, optional location change
 *   is separately audit-logged with before/after values.
 * - Uncertain edition identity remains unconfirmed.
 */
export function planPhotoMatch(candidate, matches) {
  const [first, second] = matches || [];
  if (!first) return {action:"suggest_new_book",reason:"no_candidates",needsReview:true};
  if (first.classification === "safe_book_match" &&
      (!second || first.score-second.score>=0.10)) {
    return {action:"link_existing_book",bookId:first.bookId,editionId:first.editionId,
            needsReview:false,reason:"unambiguous_work_match"};
  }
  return {action:"review_candidates",needsReview:true,reason:"uncertain_or_ambiguous"};
}
