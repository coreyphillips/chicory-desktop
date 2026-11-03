'use strict';

/**
 * A self-signed certificate for tests only (CN=electrum.test, P-256, valid to
 * 2126), so a TLS Electrum server can run on loopback without a CA. Shared by
 * the TLS verification tests and the probe tests; the test glob
 * (server/**\/*.test.js) does not pick this file up.
 */
const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgQ7vr9az8Kedv3RMm
T8W9aXDangSxXcp0LIbzkzTfr9ahRANCAATgxLteD5h0YZO7zqXFoUUutO23y0yg
yYr/E4yuWamcdur9+zobK+Zc8FFhr5bHZ9z54pC2gjtIzZEsg2e5lg+A
-----END PRIVATE KEY-----
`;
const CERT = `-----BEGIN CERTIFICATE-----
MIIBhzCCAS2gAwIBAgIUB8vxeZtFbDUC2k2Kn7Y1utaJVMkwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNZWxlY3RydW0udGVzdDAgFw0yNjEwMjExODUzMDZaGA8yMTI2
MDkyNzE4NTMwNlowGDEWMBQGA1UEAwwNZWxlY3RydW0udGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABODEu14PmHRhk7vOpcWhRS607bfLTKDJiv8TjK5ZqZx2
6v37Ohsr5lzwUWGvlsdn3PnikLaCO0jNkSyDZ7mWD4CjUzBRMB0GA1UdDgQWBBRn
tBCyX50DP0e2c3h5j54H+EAD5TAfBgNVHSMEGDAWgBRntBCyX50DP0e2c3h5j54H
+EAD5TAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIDYhFJ0WSxrn
EKd/QcvNGep0RIWAdPPPkfwTHvSRjZWYAiEA9mRp2HYr2doNU4H9IpvhM0BwP7SY
Z3bvxFPi9FPgdeM=
-----END CERTIFICATE-----
`;
const OPENSSL_LINE =
	'sha256 Fingerprint=AC:46:DD:A7:16:DB:70:98:48:AC:80:A8:4E:BA:47:A7:46:73:6B:49:96:D5:3D:3B:CF:F0:7C:6E:8D:45:C4:7F';
const PIN = 'ac46dda716db709848ac80a84eba47a746736b4996d53d3bcff07c6e8d45c47f';

module.exports = { KEY, CERT, OPENSSL_LINE, PIN };
