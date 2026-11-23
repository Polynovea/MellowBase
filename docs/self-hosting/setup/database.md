# Setup wizard: the database step

The second step of the setup wizard connects Polynovea CMS to its database, creates the two database users the CMS runs as, and creates the tables. It offers three options.

| Option | What you give | Who keeps backups | Best for |
| --- | --- | --- | --- |
| Existing managed database | Endpoint name, port, database name, admin login | AWS or Azure | Teams with a cloud admin |
| Created for you | Nothing: our cloud template made it | AWS or Azure | Non-technical owners |
| On this server | A backup location | This server, through pgBackRest | Trials and small sites |

Whichever you choose, the CMS ends up with:

- `polynovea_owner`, which owns the tables and runs migrations;
- `polynovea_app`, the login the running CMS uses. It can read and write rows and run the CMS's functions, and nothing else: it cannot create, change or drop tables, schemas, functions or temporary tables.

Both get a fresh random password (32 random bytes each). They are saved, encrypted with the master key, in `config.enc`, never in `.env`. Nothing is saved until every step has passed.

## Existing managed database

Paste the **endpoint name** from your cloud console (not an IP address, which can change), the port (normally 5432), the database name and the admin (master) login. The wizard then runs five checks in order, and stops at the first one that fails with a plain fix:

| Check | What it proves | Typical fix |
| --- | --- | --- |
| 1. DNS | The name resolves to an address this installer may use | On a private endpoint: run this server in the database's VPC or virtual network |
| 2. TCP | The database answers within 5 seconds | Allow this server in the database's security group or network rules |
| 3. TLS | The server's identity verifies against the roots we ship, for the name you typed (`verify-full`) | Use the endpoint name exactly as the console shows it; on RDS use a current CA |
| 4. Login | The admin login works and may create database users | Use the master/administrator login |
| 5. Version | PostgreSQL 15 or later | Upgrade the database |

Then it creates the two users, closes the admin login, and creates the tables as `polynovea_owner`, showing each migration as it runs. Finally it checks that `polynovea_app` cannot create anything and that every table with row-level security has its access policy.

### Which addresses are accepted

The address field could otherwise be used to probe this server's network, so:

- The name is resolved **once**, and every connection goes to that exact address. A second DNS answer is never used.
- These are **always refused**, whatever the name: loopback (`127.0.0.0/8`, `::1`), `localhost` and `*.localhost`, link-local (`169.254.0.0/16`, `fe80::/10`), `0.0.0.0/8`, multicast, reserved and documentation ranges, NAT64, the cloud metadata and platform addresses (`169.254.169.254`, `fd00:ec2::254`, Azure's `168.63.129.16`), and the same addresses written inside IPv6 (`::ffff:127.0.0.1` and similar). If any address a name resolves to is in this list, the whole name is refused.
- **Private addresses** (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`, `fc00::/7`) are accepted only for Amazon RDS endpoints (`….rds.amazonaws.com`) and Azure Database for PostgreSQL endpoints (`….postgres.database.azure.com`), or for hosts the operator allows (below).
- An IP address typed directly is accepted only if it is public.

### Allowing another private database (operators)

To use a private database that is not RDS or Azure, set `POLYNOVEA_SETUP_DB_ALLOWLIST` in the server's environment before starting setup. It takes exact hostnames and networks, separated by commas or spaces:

```
POLYNOVEA_SETUP_DB_ALLOWLIST=db.corp.internal, 10.20.0.0/16
```

A hostname entry allows that name's private addresses; a network entry allows private addresses inside it. The always-refused list still applies. The wizard cannot change this setting. A malformed entry stops the step rather than being ignored.

### TLS

Every managed connection uses TLS with full certificate and hostname checks, against these roots only (not the operating system's store):

- the Amazon RDS global bundle (`lib/setup/database/ca/rds-global-bundle.pem`, from AWS's trust store);
- DigiCert Global Root G2 and Microsoft RSA Root Certificate Authority 2017 (Azure), taken from Node.js's built-in store and pinned by fingerprint.

We trust roots only, because both clouds rotate intermediate certificates without notice. There is no fallback to an unverified connection. A server signed by any other authority is refused at check 3.

### The admin login is used once

The admin password is used for one request. It is never written to `config.enc`, a log, a progress event, a file or a database row:

- it is sent only in the body of the form's POST request, never in a URL;
- once the admin login has signed in, the wizard drops its copy, and the connected client no longer holds it either;
- the two new users' passwords are sent to the database as SCRAM verifiers computed on this server, so their plain text never reaches the database server or its statement log;
- the admin connection is closed before migrations start.

### Starting again

If a run stops part-way (for example, the network drops during migrations), run the step again: a database that has the CMS's migration ledger but no `installation` row picks up where it stopped. A database whose `installation` row exists already belongs to an install and is refused. A database with CMS tables but no migration ledger is also refused.

Two runs never interleave: one server runs one database step per setup session (two at most in total), each setup session may start ten runs every ten minutes, and migrations hold a database lock that a second run (or `npm run db:migrate` by hand) waits for or is refused by.

## Created for you

Our AWS and Azure templates create the database and store its admin login in AWS Secrets Manager or Azure Key Vault, readable only by this server's role or managed identity. The template sets `POLYNOVEA_DB_SECRET_REF` to the secret's ARN (AWS) or secret URI (Azure). The wizard reads the secret once, runs the same five checks, users and migrations as above, and never stores the secret.

The secret must be JSON with `host`, `username` and `password`, and optionally `port` (default 5432) and `dbname` (default `postgres`): the shape of an RDS secret attached to its database instance.

## On this server

The bundled PostgreSQL runs on this server's **data disk**; the wizard refuses to continue if the database folder is on the root disk. It listens on this server only (127.0.0.1 or a local socket) and the wizard checks that before using it.

Backups use pgBackRest, encrypted on this server with a generated repository password (saved in `config.enc`). Choose where they go:

| Backup location | Cost | Notes |
| --- | --- | --- |
| Amazon S3 bucket (recommended on AWS) | Roughly US$0.023 per GB per month plus requests, billed by AWS | Uses the server's instance role; no keys stored |
| Azure Blob container (recommended on Azure) | Roughly US$0.02 per GB per month plus requests, billed by Azure | Uses the server's managed identity; no keys stored |
| This server's data disk | Free | **If this server or its disk is lost, the backups are lost with it** |

Prices are approximate list prices and vary by region; your cloud bill is what counts.

Setup does not finish until pgBackRest's `stanza-create`, `check`, a first full backup and `verify` have all passed. A real restore test needs time and a scratch database, so it is recorded as the backup worker's first job.

## Troubleshooting for operators

Every failure the browser sees ends with a reference such as `(ref 1a2b3c4d)`. The server log has the underlying error under that reference, with any secret removed.
