# The owner account

The last part of setup creates the **owner**: the one account that can do everything in the CMS,
including adding other people. It takes a few minutes, one screen at a time, at `/setup/owner`.

Nothing is saved until you press **Finish**. The setup code works once; when you use it, the server
log prints a replacement code. If you close the tab, or want to carry on in another browser, enter
that replacement code (within the hour) and you pick up where you left off, progress included. A
restart prints a fresh code but starts the owner step again from the beginning.

## What you'll be asked for

| Screen | What you do | Why |
| --- | --- | --- |
| **Account** | Your email, your name and a password of at least 15 characters. | A long password is the first lock. It's checked against lists of leaked passwords and stored only as an Argon2id hash. |
| **Authenticator app** | Scan a QR code with an app such as Google Authenticator, Microsoft Authenticator or 1Password, then type the 6-digit code it shows. | Each password sign-in also needs the current code from your phone. |
| **Passkey** | Press **Add a passkey** and confirm with your fingerprint, face or device PIN. | Required for the owner. It signs you in without a password, and it's your way in if your phone is lost. |
| **Recovery codes** | Save 10 one-time codes (copy, download or print), then type the one you're asked for. | If you lose both your phone and your passkey, each code signs you in once. They're shown only on this screen. |
| **Organisation** | Your organisation's name, a name for your first workspace, and whether to add starter content. | Names appear in the CMS; you can change them later. |
| **Keys** | Save the master key (and, for a database on this server, the backup password), then type the last 6 characters of each. | Without the master key, a restored backup can't be read. Keep it in a password manager, away from the server and its backups. |
| **Finish** | Press **Finish setup**. | Everything is saved at once, setup closes for good, and you go to the normal sign-in page. |

If your server's administrator supplied the master key (`CMS_MASTER_KEY`), the Keys screen has
nothing new to show for it.

## Passkeys and the address you use

A passkey belongs to the address it was made on, which is the CMS's `POLYNOVEA_PUBLIC_URL`
(never whatever the browser happened to type).

- **Your own domain** (`https://cms.example.com`): the passkey keeps working.
- **SSH tunnel or another `localhost` address**: the wizard shows this warning, and it means what
  it says:

  > Your passkey only works on this address. If the address changes, sign in with your
  > authenticator app and you'll be asked to register a new passkey.

  Your authenticator app and recovery codes don't depend on the address.

## Signing in afterwards

The sign-in page at `/admin` offers:

- **Password, then the code** from your authenticator app; or
- **Password, then a recovery code** (each works once); or
- **Sign in with a passkey**.

The owner always has two ways to prove it's them besides the password (the authenticator app and
the passkey), so the CMS never asks the owner to set up more before they can work.

## Starter content

If you ticked **Add starter content**, the CMS creates an example "Starter Article" content type
and a draft "Welcome to Polynovea" article right after setup. It runs separately: if it fails, your
account is not affected. It retries a few times; if it still fails, the server log says so and an
administrator can run `npm run seed:starter` later. Running it again never makes duplicates.

With the built-in sign-in, the command signs in as the owner and asks for the one-time code from
the authenticator app (or one recovery code):
`npm run seed:starter -- --email=you@example.com --password=... --code=123456`.

## If two people finish at the same time

Only one owner can ever be created. Setup can be open in one browser at a time, and the final save
takes a lock: if someone else finishes first, you see "Setup was finished in another browser" and
nothing of yours is saved. Sign in with the owner account they created.

## Setting up from the command line instead

`npm run bootstrap:admin` (with `AUTH_PROVIDER=builtin`) still creates the owner without the
browser, for automated installs and tests. It also records the installation, so the CMS leaves
setup mode:

```
npm run bootstrap:admin -- --email=owner@example.com --organisation="Example Ltd" --database-mode=managed
```

- `--organisation`: defaults to the workspace's name.
- `--database-mode`: `local` (database on this server), `managed` (the default) or `created`.
- With no `--password`, it asks for one without showing it.

An owner created this way has only a password: the CMS asks them to add two sign-in methods
(passkeys or an authenticator app) at first sign-in.

## For operators: what Finish writes

One database transaction, as the CMS's own `polynovea_app` login:

1. A lock, then a check that setup isn't already finished.
2. The first workspace's name (its internal key stays `polynovea`).
3. The owner's sign-in and CMS profile (active master admin, workspace owner).
4. The authenticator secret and recovery codes, encrypted with `POLYNOVEA_AUTH_SECRET` in the
   built-in auth's own format (recovery codes stay encrypted).
5. The passkey.
6. The `installation` row (organisation, owner, database mode). The app login can add this row
   but never change or delete it.
7. A `setup.completed` entry in the platform audit log, with no secrets in it.

Any failure undoes all of it. After the commit the CMS switches to running without a restart, and
every `/setup` address answers 404 from then on, including after restarts.
