# Database root certificates

`rds-global-bundle.pem` is Amazon RDS's global root bundle. The setup wizard and the running CMS trust it
only for Amazon RDS endpoint names (`*.rds.amazonaws.com`), and only as trust anchors: nothing is
pinned below the roots, because AWS rotates intermediate certificates without notice.

- Source: https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
- Downloaded: 2026-11-23
- SHA-256: 90a6f1a7978a1b1b096dca6c57511ca48d3b8cf052f8e704baf358f34ea2f21b

The same SHA-256 is recorded as `RDS_BUNDLE_SHA256` in `../caBundles.mjs`. The CMS refuses a file that
does not match it, and `caBundles.test.ts` fails, so any change to the bundle is deliberate and reviewed.

## Refreshing the bundle

Refresh it when AWS announces new RDS certificate authorities, and well before the oldest root in the
bundle expires (the refresh script prints every expiry date).

1. Run `node scripts/refresh-rds-ca.mjs`. It downloads the bundle from the source above only, prints the
   old and new SHA-256 and each certificate's name and expiry date, and updates this file, the bundle and
   `RDS_BUNDLE_SHA256`.
2. Read the printed certificates: they should all be Amazon RDS root CAs.
3. Run the unit tests and commit the three files together, with a note on why it changed.

Azure Database for PostgreSQL is verified with DigiCert Global Root G2 and Microsoft RSA Root
Certificate Authority 2017 instead. Those come from Node.js's built-in root store, pinned by
fingerprint in `../caBundles.mjs`, so no file is shipped for them.
