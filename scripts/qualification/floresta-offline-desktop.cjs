'use strict';

// Test entrypoint for the source Electron app. The existing Settings factory
// accepts a supervisor. Supply its private loopback peer only in this process.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ManagedFloresta } = require('../../desktop/floresta.cjs');
const settings = require('../../desktop/floresta-settings.cjs');

assert(process.versions.electron && process.type === 'browser');
const profile = fs.realpathSync(process.env.CHICORY_PROFILE_DIR);
assert.equal(path.dirname(path.dirname(profile)), fs.realpathSync(os.tmpdir()));
assert(path.basename(path.dirname(profile)).startsWith('chicory-qualify-proof-'));
const port = Number(process.env.CHICORY_QUALIFY_OFFLINE_PORT);
assert(Number.isInteger(port) && port > 0 && port <= 65535);
settings.FlorestaSettings = class extends settings.FlorestaSettings {
  constructor(options) {
    super({ ...options, create(config) {
      assert.equal(config.network, 'regtest');
      assert.equal(fs.realpathSync(config.profileDirectory), profile);
      const node = new ManagedFloresta({ ...config,
        spawnProcess: (file, args, processOptions) => spawn(file, [...args, '--connect', '127.0.0.1:' + port], processOptions) });
      // Main-process test handles have no renderer or network route.
      globalThis.offlineFixtureNode = node;
      return node;
    } });
  }
};
require('../../desktop/main.cjs');
