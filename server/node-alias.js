'use strict';

/**
 * The wallet's name as its Lightning node alias.
 *
 * Beignet 0.41.0 applies BOLT 1's string rule to the alias and refuses to
 * start a node whose alias holds a control, format (zero-width, bidi, the
 * U+200D that joins emoji), surrogate, private-use or unassigned character
 * (coreyphillips/beignet#2074). A wallet name is free text, and one that
 * started a daemon before would stop it after the update, so line breaks and
 * tabs become a space and the other characters are left out. The name the
 * dashboard shows is unchanged.
 */
function nodeAlias(name) {
	return String(name ?? '')
		.replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
		.replace(/\p{C}/gu, '')
		.trim();
}

module.exports = { nodeAlias };
