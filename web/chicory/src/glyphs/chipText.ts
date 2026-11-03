/**
 * A reference, request or address as a chip draws it (REDESIGN.md 5,
 * CopyChip): its scheme and prefix whole, the rest in groups of four,
 * shortened in the middle. Plain text, so Send's model reads it too.
 */

/** Characters kept at each end of a shortened value. */
const KEEP = 8;

/** Characters in a group. */
const GROUP = 4;

const groups = (text: string) => text.match(/.{1,4}/g)?.join(' ') ?? '';

/** A URI's scheme, such as "bitcoin:" or "lightning:". */
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * The human-readable part of a Bitcoin address or a Lightning invoice or
 * offer, with the "1" that ends it: "bc1", "bcrt1", "lnbcrt30u1", "lno1".
 * Bech32 keeps "1" out of its data, so the separator is the last "1" before
 * the data runs to the end of the address or on to the URI's query.
 */
const HRP =
  /^(?:bc|tb|bcrt|ln[a-z0-9]*)1(?=[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}(?:$|[?&#]))/i;

/**
 * What a value starts with that reads as one word: the scheme of a URI and
 * the human-readable part of what follows it. Grouping these in fours cut
 * them apart, "bitc oin:" and "lnbc rt30" (P10, 22-t4-detail).
 */
export function chipLead(value: string): { words: string[]; length: number } {
  const scheme = value.match(SCHEME)?.[0] ?? '';
  const hrp = value.slice(scheme.length).match(HRP)?.[0] ?? '';
  return {
    words: [scheme, hrp].filter(Boolean),
    length: scheme.length + hrp.length,
  };
}

/**
 * The value as shown: its scheme and prefix whole, the rest grouped in
 * fours, and shortened in the middle when it is long. A shortened value
 * with a prefix keeps one group after it, so the chip stays about as wide.
 */
export function chipText(value: string, full = false): string {
  const lead = chipLead(value);
  const rest = value.slice(lead.length);
  const words = lead.words.map(word => `${word} `).join('');
  if (full || rest.length <= KEEP * 2 + GROUP) return words + groups(rest);
  const head = rest.slice(0, lead.length ? GROUP : KEEP);
  return `${words}${groups(head)} … ${groups(rest.slice(-KEEP))}`;
}
