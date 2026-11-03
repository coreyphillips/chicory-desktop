'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Persists wallet metadata (not secrets) to a JSON file on the data volume.
 * Secrets (mnemonic, api token) live per-wallet under wallets/<id>/secrets.
 */
class Registry {
	constructor(file) {
		this.file = file;
		this.records = new Map();
		// A file that exists but could not be read: { message, backup, at }.
		// While it is set, save() refuses, because the only copy of every
		// other wallet's record is in that file and a save would replace it
		// with whatever few records were added since. Missing is not an
		// error: a fresh data dir has no registry yet.
		this.loadError = null;
	}

	load() {
		try {
			const raw = fs.readFileSync(this.file, 'utf8');
			const arr = JSON.parse(raw);
			for (const rec of arr) this.records.set(rec.id, rec);
		} catch (err) {
			if (err.code === 'ENOENT') return;
			if (this.loadError) return;
			const backup = this._keepUnreadable();
			this.loadError = { message: err.message, backup, at: Date.now() };
			console.error(`registry: failed to read ${this.file}: ${err.message}`);
			console.error(
				`registry: refusing to write ${this.file} until it is repaired or removed` +
					(backup ? `; a copy was kept at ${backup}` : '')
			);
		}
	}

	/** Copy the unreadable file aside so nothing is lost while it is looked at. */
	_keepUnreadable() {
		const backup = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		try {
			fs.copyFileSync(this.file, backup);
			return backup;
		} catch (err) {
			console.error(`registry: could not copy ${this.file} to ${backup}: ${err.message}`);
			return null;
		}
	}

	save() {
		if (this.loadError) {
			throw new Error(
				`registry file could not be parsed; refusing to overwrite it (${this.loadError.message})` +
					(this.loadError.backup ? `; a copy was kept at ${this.loadError.backup}` : '')
			);
		}
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
		fs.renameSync(tmp, this.file);
	}

	list() {
		return [...this.records.values()];
	}

	get(id) {
		return this.records.get(id);
	}

	upsert(rec) {
		this.records.set(rec.id, rec);
		this.save();
	}

	remove(id) {
		this.records.delete(id);
		this.save();
	}
}

module.exports = { Registry };
