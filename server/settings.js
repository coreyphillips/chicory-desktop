'use strict';

const fs = require('fs');
const path = require('path');

/**
 * App-level settings persisted to the data volume. Holds the default network
 * and default Electrum server applied to new wallets (each wallet can still
 * override them). Seeded from environment defaults on first boot; the file
 * takes over once written.
 */
class Settings {
	constructor(file, seed) {
		this.file = file;
		// A file that exists but could not be read: { message, backup, at }.
		// Settings are only ever written whole, so while it is set the file on
		// disk holds something these defaults would replace; load() copies it
		// aside first, because the guardian set in it is entered by hand and
		// kept nowhere else.
		this.loadError = null;
		this.data = {
			defaultNetwork: seed.defaultNetwork,
			defaultElectrum: seed.defaultElectrum || null,
			// The guardian set new guardian-mode wallets register with (empty
			// when none is configured). Each wallet pins its own copy at the
			// moment it first enables a guardian mode; this is only the default.
			recoveryGuardians: [],
			// When this box last wrote a backup archive. Per-wallet stamps live
			// on the records; this is the one the wallet list shows.
			lastBackupAt: null
		};
	}

	load() {
		try {
			const raw = fs.readFileSync(this.file, 'utf8');
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === 'object') {
				this.data = { ...this.data, ...parsed };
			}
		} catch (err) {
			if (err.code === 'ENOENT') return;
			if (this.loadError) return;
			const backup = this._keepUnreadable();
			this.loadError = { message: err.message, backup, at: Date.now() };
			console.error(`settings: failed to read ${this.file}: ${err.message}`);
			console.error(
				'settings: defaults are in use and the next save writes them over it' +
					(backup ? `; a copy was kept at ${backup}` : '')
			);
		}
	}

	/** Copy the unreadable file aside so the next save does not take it with it. */
	_keepUnreadable() {
		const backup = `${this.file}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
		try {
			fs.copyFileSync(this.file, backup);
			return backup;
		} catch (err) {
			console.error(`settings: could not copy ${this.file} to ${backup}: ${err.message}`);
			return null;
		}
	}

	save() {
		// The copy load() kept aside is what makes writing over an unreadable
		// file safe. Without one these defaults would be all that is left of it,
		// so try the copy again (the disk or the data dir may have been fixed
		// since boot) and refuse if it still cannot be made. A file that is gone
		// has nothing left to lose: removing it is the remedy we tell people.
		if (this.loadError && !this.loadError.backup) {
			this.loadError.backup = this._keepUnreadable();
			if (!this.loadError.backup && fs.existsSync(this.file)) {
				throw new Error(
					`settings file could not be read and no copy of it could be kept; refusing to overwrite it (${this.loadError.message})`
				);
			}
		}
		fs.mkdirSync(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
		fs.renameSync(tmp, this.file);
		// What could not be read has now been replaced; the copy load() kept
		// aside is what is left of it.
		this.loadError = null;
	}

	get() {
		return this.data;
	}

	update(patch) {
		if (patch.defaultNetwork !== undefined) {
			this.data.defaultNetwork = patch.defaultNetwork;
		}
		if (patch.defaultElectrum !== undefined) {
			// null clears the default (wallets must then specify a server).
			this.data.defaultElectrum = patch.defaultElectrum;
		}
		if (patch.recoveryGuardians !== undefined) {
			this.data.recoveryGuardians = patch.recoveryGuardians;
		}
		if (patch.lastBackupAt !== undefined) {
			this.data.lastBackupAt = patch.lastBackupAt;
		}
		this.save();
		return this.data;
	}
}

module.exports = { Settings };
