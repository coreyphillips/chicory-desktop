'use strict';

const fs = require('fs');

/**
 * An append-only JSON-lines file for per-wallet history that has to outlive
 * the manager process: a channel's lifecycle, a direct funding that degraded
 * into an ordinary payment.
 *
 * The contract every caller depends on: a failure to read or write is never
 * presented as recorded, durable history. A file that cannot be read is not
 * written through either, because compacting over entries we could not see
 * would destroy them.
 */
class JsonlLog {
	constructor(file, { max = 500, label = 'history', warn } = {}) {
		this.file = file;
		this.max = max;
		this.label = label;
		this.warn = warn || (() => {});
		this.entries = null; // loaded lazily, so a stopped wallet is still readable
		this.broken = false;
		// A file whose last line has no newline: appending straight onto it would
		// join two records into one unparseable line, losing both.
		this.unterminated = false;
	}

	_load() {
		if (this.entries) return;
		this.entries = [];
		let raw;
		try {
			raw = fs.readFileSync(this.file, 'utf8');
		} catch (err) {
			if (err && err.code === 'ENOENT') return; // genuinely nothing yet
			this.broken = true;
			this.warn(
				`${this.label} unreadable (${err.message}); recording in memory only for this session`
			);
			return;
		}
		this.unterminated = raw.length > 0 && !raw.endsWith('\n');
		for (const line of raw.split('\n')) {
			if (!line.trim()) continue;
			try {
				this.entries.push(JSON.parse(line));
			} catch (err) {
				// A torn write loses one line, not the log; but say so rather than
				// silently presenting a shortened history as complete.
				this.warn(`ignoring malformed ${this.label} entry: ${err.message}`);
			}
		}
	}

	/**
	 * Append one entry, returning { entry, persisted }: persisted is false when
	 * the entry lives only in this process's memory (unwritable disk,
	 * unreadable log), so the caller never mistakes a session-only note for the
	 * durable record.
	 */
	append(entry) {
		this._load();
		this.entries.push(entry);
		let persisted = false;
		if (!this.broken) {
			try {
				if (this.entries.length > this.max) {
					// Compact: keep the newest `max` and rewrite atomically, so a
					// crash mid-write leaves the old file rather than half a file.
					this.entries = this.entries.slice(-this.max);
					const tmp = `${this.file}.tmp`;
					fs.writeFileSync(tmp, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
					fs.renameSync(tmp, this.file);
				} else {
					fs.appendFileSync(
						this.file,
						(this.unterminated ? '\n' : '') + JSON.stringify(entry) + '\n'
					);
				}
				this.unterminated = false;
				persisted = true;
			} catch (err) {
				// A write that threw may have left part of a line on disk, so the
				// next one starts on a line of its own.
				this.unterminated = true;
				this.warn(`${this.label} write failed (${err.message}); entry kept in memory only`);
			}
		}
		return { entry, persisted };
	}

	/** Every entry, oldest first. */
	all() {
		this._load();
		return this.entries.slice();
	}
}

module.exports = { JsonlLog };
