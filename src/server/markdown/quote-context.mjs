/**
 * Quote-based anchor utilities for WithAI.
 *
 * Comments are positioned by: { quote, before, after }
 * - quote: the exact text the reviewer selected
 * - before: ~200 chars of text preceding the quote in the markdown
 * - after: ~200 chars of text following the quote in the markdown
 *
 * When multiple matches of quote exist, before/after is used to disambiguate.
 */

/**
 * Given markdown and a quote string, find the quote's position and extract surrounding context.
 * If the quote appears multiple times, returns context for the first match.
 */
export function extractContext(markdown, quote, radius = 200) {
  if (!quote || !markdown) return { quote: quote || "", before: "", after: "" };
  const index = markdown.indexOf(quote);
  if (index === -1) return { quote, before: "", after: "" };
  const before = markdown.slice(Math.max(0, index - radius), index);
  const after = markdown.slice(index + quote.length, index + quote.length + radius);
  return { quote, before, after };
}

/**
 * Locate a quote in markdown using before/after context for disambiguation.
 * Returns { start, end } character offsets, or null if not found.
 */
export function locateQuote(markdown, anchor) {
  if (!anchor || !anchor.quote || !markdown) return null;
  const quote = anchor.quote;
  const matches = findAllOccurrences(markdown, quote);
  if (matches.length === 0) return null;
  if (matches.length === 1) return { start: matches[0], end: matches[0] + quote.length };

  // Multiple matches — disambiguate using before/after
  const before = anchor.before || "";
  const after = anchor.after || "";
  if (!before && !after) return { start: matches[0], end: matches[0] + quote.length };

  let bestIndex = matches[0];
  let bestScore = -1;

  for (const matchStart of matches) {
    const precedingText = markdown.slice(Math.max(0, matchStart - before.length - 50), matchStart);
    const followingText = markdown.slice(matchStart + quote.length, matchStart + quote.length + after.length + 50);
    const score = (before ? commonSuffixLength(precedingText, before) : 0) +
                  (after ? commonPrefixLength(followingText, after) : 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = matchStart;
    }
  }

  return { start: bestIndex, end: bestIndex + quote.length };
}

/**
 * Convert a character offset to a 1-based line number.
 */
export function charOffsetToLine(text, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function findAllOccurrences(text, substring) {
  const results = [];
  let pos = 0;
  while (true) {
    const index = text.indexOf(substring, pos);
    if (index === -1) break;
    results.push(index);
    pos = index + 1;
  }
  return results;
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function commonSuffixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}
