'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * The identity-and-settings backup: one passphrase-encrypted archive holding
 * the registry, the app settings, and every wallet's seed and API token.
 *
 * Nothing from a wallet's `data/` directory is in it. Those databases are
 * large and are what the Recovery Protocol restores; this covers the part
 * that is derivable from nothing, which until now left the box only as a seed
 * phrase read off a screen once.
 *
 * scrypt and AES-256-GCM come from node's own crypto, so the app gains no
 * dependency and an archive can be opened by any node on any machine.
 *
 * Archive layout:
 *
 *   magic "BEIGNET-BACKUP" | format | kdf | logN | r | p | salt(16) | iv(12)
 *   AES-256-GCM(JSON payload), header as additional data | tag(16)
 *
 * The KDF parameters are in the header rather than assumed, so raising the
 * work factor later still leaves today's archives readable.
 */

const MAGIC = Buffer.from('BEIGNET-BACKUP', 'ascii');
const FORMAT = 1;
const KDF_SCRYPT = 1;
// 2^16 * 8 * 128 bytes = 64 MiB of memory per attempt, around a second on an
// Umbrel's ARM core. High enough to make a stolen archive expensive to grind,
// low enough that the person who owns it does not think the app has hung.
const SCRYPT = { logN: 16, r: 8, p: 1 };
// An archive states its own work factor, so an archive could ask for one that
// exhausts the box. Nothing this app writes goes past 2^18 (256 MiB).
const MAX_LOG_N = 18;
// GCM cannot vouch for those parameters until after the key is derived, so
// the cost itself is capped rather than each parameter: N*r*p is 2^21 at the
// most this app would write (2^18 * 8 * 1), which is 256 MiB of scrypt memory
// and a few seconds.
const MAX_WORK = 2 ** 21;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PARAM_BYTES = 5; // format, kdf, logN, r, p
const HEADER_BYTES = MAGIC.length + PARAM_BYTES + SALT_BYTES + IV_BYTES;
// Short enough to type twice, long enough that the archive is not the weak
// half of a wallet's security.
const MIN_PASSPHRASE = 8;

// The only paths this app writes back out of an archive. Wallet ids are
// UUIDs; the character class excludes dots, so no entry can name a parent
// directory however the archive was edited.
const SAFE_PATH = /^(registry\.json|settings\.json|wallets\/[0-9a-zA-Z-]+\/secrets\/(mnemonic|api_token))$/;

class ArchiveError extends Error {
	constructor(code, message) {
		super(message);
		this.code = code;
	}
}

/** The passphrase as it will be hashed, or a refusal if it is too short. */
function assertPassphrase(passphrase) {
	const text = String(passphrase === null || passphrase === undefined ? '' : passphrase).normalize(
		'NFKC'
	);
	if (text.length < MIN_PASSPHRASE) {
		throw new ArchiveError(
			'WEAK_PASSPHRASE',
			`The backup passphrase must be at least ${MIN_PASSPHRASE} characters: every seed on this box is only as safe as it is.`
		);
	}
	return text;
}

// Normalization matters on the way in too: the same passphrase typed on
// another machine can arrive as a different byte sequence, and scrypt would
// then derive a different key from what the owner considers the same words.
function normalizePassphrase(passphrase) {
	return String(passphrase === null || passphrase === undefined ? '' : passphrase).normalize('NFKC');
}

function deriveKey(passphrase, salt, { logN, r, p }) {
	const N = 2 ** logN;
	return crypto.scryptSync(passphrase, salt, 32, { N, r, p, maxmem: 256 * N * r });
}

function sealArchive(payload, passphrase) {
	const secret = assertPassphrase(passphrase);
	const salt = crypto.randomBytes(SALT_BYTES);
	const iv = crypto.randomBytes(IV_BYTES);
	const header = Buffer.concat([
		MAGIC,
		Buffer.from([FORMAT, KDF_SCRYPT, SCRYPT.logN, SCRYPT.r, SCRYPT.p]),
		salt,
		iv
	]);
	const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret, salt, SCRYPT), iv);
	cipher.setAAD(header);
	const sealed = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
	return Buffer.concat([header, sealed, cipher.getAuthTag()]);
}

function openArchive(archive, passphrase) {
	const buf = Buffer.isBuffer(archive) ? archive : Buffer.from(archive || []);
	const notOurs = () =>
		new ArchiveError('BAD_ARCHIVE', 'That file is not a Beignet backup archive.');
	if (buf.length < HEADER_BYTES + TAG_BYTES) throw notOurs();
	if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw notOurs();
	const [format, kdf, logN, r, p] = buf.subarray(MAGIC.length, MAGIC.length + PARAM_BYTES);
	if (format !== FORMAT) {
		throw new ArchiveError(
			'BAD_ARCHIVE',
			`This archive is format ${format} and this app reads format ${FORMAT}. Update the app and try again.`
		);
	}
	if (
		kdf !== KDF_SCRYPT ||
		logN < 1 ||
		logN > MAX_LOG_N ||
		r < 1 ||
		p < 1 ||
		2 ** logN * r * p > MAX_WORK
	) {
		throw new ArchiveError('BAD_ARCHIVE', 'This archive names an encryption this app cannot read.');
	}
	const saltAt = MAGIC.length + PARAM_BYTES;
	const header = buf.subarray(0, saltAt + SALT_BYTES + IV_BYTES);
	const salt = buf.subarray(saltAt, saltAt + SALT_BYTES);
	const iv = buf.subarray(saltAt + SALT_BYTES, HEADER_BYTES);
	const body = buf.subarray(HEADER_BYTES, buf.length - TAG_BYTES);
	const tag = buf.subarray(buf.length - TAG_BYTES);
	let key;
	try {
		key = deriveKey(normalizePassphrase(passphrase), salt, { logN, r, p });
	} catch (_) {
		// Within the bounds above and still not a combination scrypt accepts
		// (2^1 * 1 * 1 is one): the archive names an encryption, not a fault here.
		throw new ArchiveError('BAD_ARCHIVE', 'This archive names an encryption this app cannot read.');
	}
	const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAAD(header);
	decipher.setAuthTag(tag);
	let plain;
	try {
		plain = Buffer.concat([decipher.update(body), decipher.final()]);
	} catch (_) {
		// GCM cannot tell a wrong key from a damaged archive: both are a tag
		// that does not verify, and saying so is more use than guessing.
		throw new ArchiveError(
			'BAD_PASSPHRASE',
			'That passphrase does not open this archive (or the file is damaged).'
		);
	}
	try {
		return JSON.parse(plain.toString('utf8'));
	} catch (err) {
		throw new ArchiveError('BAD_ARCHIVE', `The archive opened but its contents are broken (${err.message}).`);
	}
}

/**
 * Read what belongs in an archive off the data volume: the registry and
 * settings files as they are, and each wallet's two secrets. Files are copied
 * verbatim, with their modes, so a restore can put them back exactly.
 */
function buildPayload({ dataDir, walletIds, app, engine, createdAt }) {
	const files = [];
	const add = (rel, required) => {
		const abs = path.join(dataDir, ...rel.split('/'));
		let data;
		try {
			data = fs.readFileSync(abs);
		} catch (err) {
			if (err.code === 'ENOENT' && !required) return;
			throw new ArchiveError(
				'BACKUP_INCOMPLETE',
				`${rel} could not be read (${err.message}), so this archive would not restore the box.`
			);
		}
		files.push({ path: rel, mode: fs.statSync(abs).mode & 0o777, data: data.toString('base64') });
	};
	// The wallet records live in registry.json; it is required as soon as
	// there is a wallet to record.
	add('registry.json', walletIds.length > 0);
	add('settings.json', false);
	for (const id of walletIds) {
		add(`wallets/${id}/secrets/mnemonic`, true);
		add(`wallets/${id}/secrets/api_token`, true);
	}
	return { createdAt, app: app || null, engine: engine || null, files };
}

/** The archive's files by path, refusing any path this app will not write. */
function payloadFiles(payload) {
	const map = new Map();
	const list = payload && Array.isArray(payload.files) ? payload.files : [];
	for (const entry of list) {
		const rel = String((entry && entry.path) || '');
		if (!SAFE_PATH.test(rel)) {
			throw new ArchiveError('BAD_ARCHIVE', `The archive names a file this app will not write: ${rel}`);
		}
		map.set(rel, {
			mode: Number.isInteger(entry.mode) ? entry.mode & 0o777 : 0o600,
			data: Buffer.from(String(entry.data || ''), 'base64')
		});
	}
	return map;
}

function payloadRegistry(files) {
	const entry = files.get('registry.json');
	if (!entry) return [];
	let parsed;
	try {
		parsed = JSON.parse(entry.data.toString('utf8'));
	} catch (err) {
		throw new ArchiveError('BAD_ARCHIVE', `The wallet list in this archive could not be read (${err.message}).`);
	}
	if (!Array.isArray(parsed)) {
		throw new ArchiveError('BAD_ARCHIVE', 'The wallet list in this archive is not a list of wallets.');
	}
	return parsed.filter((rec) => rec && typeof rec.id === 'string');
}

function payloadSettings(files) {
	const entry = files.get('settings.json');
	if (!entry) return null;
	try {
		const parsed = JSON.parse(entry.data.toString('utf8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
	} catch (_) {
		// Settings are defaults for new wallets, not wallets: a restore that
		// could not read them is still worth having.
		return null;
	}
}

/** A seed's fingerprint, so two wallets can be compared without holding both. */
function seedDigest(text) {
	const seed = String(text === null || text === undefined ? '' : text).trim();
	return seed ? crypto.createHash('sha256').update(seed).digest('hex') : null;
}

function mnemonicPath(id) {
	return `wallets/${id}/secrets/mnemonic`;
}

function tokenPath(id) {
	return `wallets/${id}/secrets/api_token`;
}

/**
 * What restoring this archive onto a box that already holds `existing` would
 * do, wallet by wallet. `existing` is one entry per wallet already here:
 * { id, name, nodeId, seedHash }.
 *
 * A wallet already here under the same id is the same wallet, so it is left
 * alone. The same seed under a DIFFERENT id is the case worth stopping on:
 * two records on one box running one seed is how channels get lost. A twin is
 * looked for among the wallets this restore would leave on the box, not only
 * the ones already here: an archive holding two records on one seed puts the
 * box in that state just as surely.
 */
function planRestore({ records, files, existing }) {
	const identities = existing.slice();
	const wallets = records.map((rec) => {
		const seedHash = seedDigest(
			files.has(mnemonicPath(rec.id)) ? files.get(mnemonicPath(rec.id)).data.toString('utf8') : ''
		);
		const here = existing.find((w) => w.id === rec.id);
		const twin = identities.find(
			(w) =>
				w.id !== rec.id &&
				((w.nodeId && rec.nodeId && w.nodeId === rec.nodeId) ||
					(w.seedHash && seedHash && w.seedHash === seedHash))
		);
		const complete = files.has(mnemonicPath(rec.id)) && files.has(tokenPath(rec.id));
		const action = here ? 'present' : complete ? 'restore' : 'incomplete';
		if (action === 'restore') {
			identities.push({ id: rec.id, name: rec.name || rec.id, nodeId: rec.nodeId || null, seedHash });
		}
		return {
			id: rec.id,
			name: rec.name || rec.id,
			network: rec.network || null,
			nodeId: rec.nodeId || null,
			onchainOnly: !!rec.onchainOnly,
			action,
			presentAs: here ? here.name : null,
			duplicateOf: twin ? { id: twin.id, name: twin.name } : null
		};
	});
	return {
		wallets,
		conflicts: wallets.filter((w) => w.action === 'restore' && w.duplicateOf)
	};
}

/**
 * True when a wallet has never been put in an archive, or has been edited
 * since the last one was written. Records made before the stamp existed carry
 * no updatedAt, so their creation stands in for their last edit.
 */
function backupStale(rec) {
	const backedUp = Date.parse((rec && rec.lastBackupAt) || '');
	if (!Number.isFinite(backedUp)) return true;
	const changed = Date.parse(rec.updatedAt || rec.createdAt || '');
	return Number.isFinite(changed) ? changed > backedUp : false;
}

/** What the archive says about itself, for a preview before anything is written. */
function describePayload(payload) {
	return {
		createdAt: (payload && payload.createdAt) || null,
		app: (payload && payload.app) || null,
		engine: (payload && payload.engine) || null
	};
}

function backupFilename(createdAt) {
	const stamp = String(createdAt || '').replace(/[:.]/g, '-').replace(/-\d{3}Z$/, 'Z');
	return `beignet-backup-${stamp || 'archive'}.beignet`;
}

module.exports = {
	ArchiveError,
	MIN_PASSPHRASE,
	assertPassphrase,
	sealArchive,
	openArchive,
	buildPayload,
	payloadFiles,
	payloadRegistry,
	payloadSettings,
	planRestore,
	backupStale,
	describePayload,
	seedDigest,
	mnemonicPath,
	tokenPath,
	backupFilename
};
