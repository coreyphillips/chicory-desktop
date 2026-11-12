> Historical upstream evidence: this report was produced for Chicory Umbrel. It does not record funded tests of the desktop package.

# Funded regtest verification

The payment harness uses the real `UmbrelWalletClient`, this repository's
manager, Bitcoin Core 31 and Electrs. It creates independent regtest wallets
and uses mined test coins. It never uses an existing wallet manager or changes
an existing Docker stack.

## Start the isolated chain

```sh
docker compose -f scripts/regtest/compose.yml up -d
docker exec chicory-browser-regtest-bitcoin-1 bitcoin-cli -datadir=/data -regtest createwallet chicory-test
docker exec chicory-browser-regtest-bitcoin-1 bitcoin-cli -datadir=/data -regtest -rpcwallet=chicory-test -generate 101
```

The stack has its own network and named volumes. Bitcoin RPC binds to
`127.0.0.1:29443`, and Electrum binds to `127.0.0.1:62401`. The Electrs process
runs as root inside this disposable test container so its new named volume is
writable. This is test infrastructure, separate from the app container.

## Prepare the host engine

The production image installs Beignet 0.39.0 and applies the project-owned
fresh-address and zero-reserve patches during its engine stage. For local development, install
the engine in a separate directory rather than patching a source checkout:

```sh
mkdir -p /tmp/chicory-regtest-engine
npm install --prefix /tmp/chicory-regtest-engine beignet@0.39.0
node scripts/apply-engine-patches.mjs /tmp/chicory-regtest-engine/node_modules/beignet
```

The patch checks the exact package version and compiled method shapes before
writing, is idempotent, and refuses a directory containing `.git`. It preserves
the ordinary `/address/new` route. The bridge explicitly requests `fresh:true`
and requires a matching acknowledgement. The patched method advances the
durable receive index and registers its exact Electrum subscription before
acknowledging the address. It respects the wallet's unused-address gap limit.

The zero-reserve patch builds a daemon that is not a primary as a wallet, the
way the portable engine Chicory mobile runs does, so it advertises
`option_zero_reserve` and accepts the reserve waiver its primary offers when
it opens a just-in-time channel. Without it the wallet keeps a reserve (546
sats at least) that send max over Lightning can never spend. A daemon that
waives its clients' reserve or sells just-in-time receives keeps the primary
role. The patch changes only channels opened after it.

## Start the test manager

```sh
npm --prefix server ci
DATA_DIR=/tmp/chicory-regtest-wallets \
BEIGNET_BIN=/tmp/chicory-regtest-engine/node_modules/beignet/dist/cli/cli.js \
PORT=3920 DEFAULT_NETWORK=regtest \
DEFAULT_ELECTRUM_HOST=127.0.0.1 DEFAULT_ELECTRUM_PORT=62401 \
DEFAULT_ELECTRUM_TLS=false CHILD_PORT_BASE=3921 CHILD_PORT_MAX=3970 \
node server/index.js
```

Use a new dedicated data directory. Lightning listens at the allocated daemon
port plus 6000. The manager and daemon data stay outside this checkout.

## Run the flows

```sh
node scripts/regtest/payments.ts
```

Before any wallet is created, the harness verifies the exact regtest genesis
through Bitcoin RPC and Electrum and checks the manager's network. It refuses
a manager that contains any other network. Environment overrides are
`REGTEST_MANAGER_URL`, `REGTEST_BITCOIN_CONTAINER`, `REGTEST_ELECTRUM_PORT` and
`REGTEST_STATE_FILE`. The manager URL must be loopback.

The harness covers:

- Real wallet creation and selection through the shared browser client.
- Unconfirmed on-chain funding, confirmation and automatic channel funding.
- Two unused unified requests with different Bitcoin addresses, then paying
  both after a wallet restart to prove both remain watched.
- Exact Bitcoin request outputs before and after confirmation.
- Lightning receive quote, invoice creation, payment review, send, settlement
  and matching received Activity.
- Refusal of an already consumed review, insufficient funds and expired review.
- On-chain send review, actual mempool output and fee, confirmation and Activity.
- Restored Lightning payment amount and fee after stopping and reopening a
  wallet.

The final state file contains public test wallet IDs, their primary URI and
verification results. It contains no recovery phrases or daemon credentials.
Wallets remain running for browser verification. Stop this manager with
Ctrl+C when finished, then stop only this chain with:

```sh
docker compose -f scripts/regtest/compose.yml down
```

The named volumes and manager data remain available for another inspection.

## Host compatibility found by funded testing

The stock host daemon lacks the portable runtime's request registry and browser
payment journal. The manager now keeps those beside each wallet's data, using
durable writes before acknowledging requests or dispatching splice payments.
Uncertain outcomes keep their original request identity. A different request
cannot reuse a channel with an unresolved submission. Completion requires a
verified transaction spending the previous channel funding and paying the
exact recipient output.

New Bitcoin requests cannot claim an address with earlier chain history. The
request's amount is checked against its owned invoice and URI. Receipt lookup
sums only the exact address outputs of transactions whose IDs match their raw
bytes.

Beignet 0.39.0, like 0.36.1, reports completed outgoing payment amounts as total
debit with fees included. The manager names that specific version's semantics explicitly.
The browser adapter projects a recipient amount only for those explicitly
marked completed records with known fees, preserving the original debit and
fee. Incoming, pending, failed, unmarked and pay-all records are unchanged.

## Verified browser evidence

The desktop browser also selected a funded regtest wallet and sent a real
1000-sat Lightning invoice. Review showed a maximum 12-sat fee and an expected
2-sat fee. A 150 ms press and release did not submit the payment. A subsequent
1100 ms hold completed it once, showing 1000 sats sent and a 2-sat fee. The
engine's exact route fee was 1001 msat. Individual fees round up to sats, while
aggregate balances carry fractional remainders, so successive balance changes
can differ from the displayed rounded fee by 1 sat.

The same browser created a new unified 1000-sat request, showing both Lightning
and Bitcoin payment support. A second real wallet paid it through the shared
client. The open receive screen changed to completed for payment hash
`ed617fac61281ba4d34e2096c50a3e929f3216df65955eabaa8916bf271f633e`.
Screenshots: [sent](screenshots/browser-regtest-send.jpg),
[unified QR](screenshots/browser-regtest-receive.jpg) and
[received](screenshots/browser-regtest-received.jpg).

After restarting the sender, a newly constructed client with an empty local
activity ledger restored both the 12000-sat harness payment and the 1000-sat
browser payment with their original IDs, completed status and known 2-sat
fees. This verifies the displayed recipient amounts come from durable daemon
records after a reload.
