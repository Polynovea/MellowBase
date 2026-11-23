# Built-in auth

Polynovea CMS can sign people in itself, on its own PostgreSQL database, instead of through Supabase Auth (GoTrue). It runs Better Auth behind the CMS's own provider interface. Supabase Auth stays available as the rollback path during phase 1.

## Turning it on

| Setting | Value |
| --- | --- |
| `AUTH_PROVIDER` and `NEXT_PUBLIC_AUTH_PROVIDER` | `builtin` (both, then rebuild: the browser bundle reads the second at build time) |
| `POLYNOVEA_AUTH_SECRET` | 32+ random characters. It signs session cookies and encrypts authenticator-app secrets. Never commit it, and keep it stable: changing it signs everyone out and breaks their authenticator apps. |
| `POLYNOVEA_PUBLIC_URL` | The `https://` address people use. Passkeys only work on this exact origin. |
| `POLYNOVEA_TRUSTED_PROXIES` | Addresses or CIDR ranges of the reverse proxies in front of the app; required in production. The app port must not be reachable except through them. |
| `POLYNOVEA_BREACHED_PASSWORDS_FILE` | Optional larger breached-password list, one per line. |
| `POLYNOVEA_HIBP_DISABLED` | `true` on installs without internet access (the bundled list still applies). |

The app checks these at start-up and refuses to start when one is wrong.

## What it enforces

- **Passwords:** at least 15 characters, or 8 once the account has a passkey or authenticator app; up to 128. Common and known-breached passwords are refused (bundled list, plus the Have I Been Pwned range API, which only ever sees the first 5 characters of a hash).
- **Two-step sign-in:** owners need two sign-in methods besides the password, and admins one. A passkey or an authenticator app each count as one. Until they have them, the CMS sends them to **Sign-in & security**. Ten single-use recovery codes are shown once.
- **Sessions:** stored in the database. They end after 12 hours without use, and always 7 days after sign-in. Changing a member's role or deactivating them signs them out. Anyone can sign out a single session, everywhere else, or everywhere.
- **Confirm it's you:** creating API tokens, changing members or roles, changing your password, and exporting entries need a sign-in within the last 10 minutes. The CMS asks for one and then carries on.
- **Throttling:** each address gets 10 sign-in attempts a minute. Each account gets **30 attempts; after that, sign-in for that account pauses until 15 minutes pass with no attempt**. Ten wrong two-step codes in a row pause two-step sign-in for 15 minutes. There is no permanent lockout. Repeated wrong guesses can keep an account paused; to reset it early, an operator deletes that account's `account:` row from `polynovea_auth."rateLimit"`.

## Moving from Supabase Auth

`polynovea-cms auth migrate` copies every GoTrue user into the built-in auth. Each user keeps the same ID, email, confirmed state and password; the password is upgraded to Argon2id at their next sign-in. A verified authenticator app is kept as well, so people who had two-step sign-in still need it. GoTrue has no recovery codes, so the command lists those users, and they make new codes on **Sign-in & security**.

**Run it once, at cutover, in maintenance mode.** Running it again later would re-create any user deleted from the built-in auth since the first run.

1. Put the install in maintenance mode.
2. Set `POLYNOVEA_AUTH_SECRET` to the value the app will use.
3. Dry run: `npm run cms -- auth migrate --dry-run`. It checks everything and writes nothing.
4. Run: `npm run cms -- auth migrate`. It prints user counts before and after.
5. Set `AUTH_PROVIDER=builtin` and `NEXT_PUBLIC_AUTH_PROVIDER=builtin`, rebuild and restart. Everyone signs in once more.

The command writes nothing, and exits with code 2, when:

- a CMS profile would be left without a user;
- two GoTrue users share an address;
- an address already belongs to another built-in user;
- an authenticator-app secret cannot be read (GoTrue's MFA secret encryption is on);
- `POLYNOVEA_AUTH_SECRET` is missing.

`--from` and `--to` take separate source and target databases, and `--user=<id>` limits a rehearsal to chosen users.

To roll back, set both settings back to `supabase` and rebuild. GoTrue still has its users. Passwords changed on the built-in auth after the switch do not carry back.
