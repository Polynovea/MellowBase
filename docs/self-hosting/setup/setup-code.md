# The setup code

A fresh Polynovea CMS belongs to whoever finishes setup first. The setup code makes sure that is you: it is printed only in the server log, so only someone who can read the log (the person running the server) can start the setup wizard.

## Where to find it

When the CMS starts without being set up, the server log shows the setup address and a code like this:

```
[setup] This CMS is not set up yet.
[setup] Open https://cms.example.com/setup to finish setup.
[setup] Setup code: 3KQ7ZD-W9M2C-XT4HB-8RVNP-6JFAE  (works once, for 1 hour; a restart issues a new one)
```

Open the address, type the code and press **Continue**. Capitals, spaces and dashes don't matter, and look-alike letters are forgiven (`I` and `L` count as `1`, `O` as `0`).

- The code works **once**, within **one hour** of being printed. If it runs out, restart the CMS to print a new one.
- As soon as it is used, the log prints a **replacement code**. You only need it to continue setup in a different browser (see "After the code").
- Every restart prints a **new** code; the old one stops working.
- The code is typed into the page, never put in the web address. A setup request with `code` in the address is refused, because addresses end up in logs.

## A secure connection comes first

The wizard only accepts the code over a connection that protects it:

| Route | Cost | What you get |
| --- | --- | --- |
| **Your own domain** with HTTPS | About $10–15 a year, paid to a domain registrar. The HTTPS certificate itself is free (Let's Encrypt). | A permanent address. You set up an authenticator app and a passkey in the wizard, and both keep working. |
| **SSH tunnel** to `localhost` | Free | Setup through the SSH connection you already use. You can add a domain later. |

If you open the setup page over plain HTTP on a public address, it shows these two choices instead of the code box.

### Your own domain

1. Buy a domain, or use one you own.
2. Add an A record (and AAAA for IPv6) pointing at the server.
3. Put a web server that handles HTTPS in front of the CMS. Caddy does it automatically.
4. Set `POLYNOVEA_PUBLIC_URL=https://your-domain` and `POLYNOVEA_TRUSTED_PROXIES` to the web server's address (`127.0.0.1` when it runs on the same machine), then restart.
5. Open `https://your-domain/setup`.

The CMS believes the web server's forwarding headers ("this was HTTPS", the visitor's address, the host name) only when the connection itself comes from an address in `POLYNOVEA_TRUSTED_PROXIES`. From anyone else they are ignored, so a visitor cannot pretend to be on HTTPS or to come from another address.

### SSH tunnel

First make sure the CMS listens only on the server itself: start it with `HOSTNAME=127.0.0.1`. While it listens on every network address (`0.0.0.0`), the wizard refuses plain HTTP even from `localhost`, because it could not tell a tunnel from a local proxy passing on someone else's request.

Then, on your own computer:

```
ssh -L 3000:localhost:3000 you@your-server
```

Leave it open and browse to `http://localhost:3000/setup`. Your browser treats `localhost` as a secure address, so the setup cookie works there (checked in Chrome on a production build).

Plain HTTP is accepted only when all of these are true: the CMS listens on `127.0.0.1` or `::1` only, the connection comes from that same machine, the request carries no forwarding headers, and the browser asked for `localhost`.

**Passkeys and free routes.** A passkey only works on the address it was created on. If you set up through the tunnel, your passkey belongs to `localhost`. When the CMS later moves to a real address, sign in with your authenticator app; the CMS then asks you to register a new passkey.

Free subdomains from duckdns.org, dedyn.io or dynv6.net are pending approval and not offered yet. sslip.io and nip.io are not offered: they are not on the Public Suffix List, so everyone using them shares Let's Encrypt's limit of 50 certificates a week.

## Wrong codes

- **Five wrong codes** from one network lock it out for **15 minutes**. A network is one IPv4 address or one IPv6 /64 block, taken from the real connection (or, behind a trusted proxy, from what that proxy reports), never from a header the visitor sends. After the 15 minutes the right code works again straight away.
- If the whole internet sends more than **200 wrong codes in an hour**, everyone has to wait a minute between attempts, including someone trying for the first time. Setup slows down but is never locked for everyone, so nobody can keep you out of your own server.
- These counters live in memory: a restart clears them, together with the code.

## Supplying your own code (automated deploys)

Set `POLYNOVEA_SETUP_CODE` when your deploy tooling needs to know the code in advance. It must carry at least 128 bits of randomness:

- 26 or more base32 characters (letters and digits, one case), or
- 22 or more base64 characters (mixed case, may include `+ / _ -`), for example from `openssl rand -base64 18`.

Anything shorter, or obviously repetitive, stops the CMS at start-up with an error that names the rule (never the value). Once read, the code is hashed and removed from the process environment, the log says only that the supplied code is in use, and it expires an hour after start-up like a generated one.

## After the code

A correct code opens a setup session in that browser for one hour (a secure, HttpOnly cookie named `__Host-polynovea-setup`) and is used up. Only one browser can be setting up at a time: entering the **replacement code** from the log in a second browser moves setup there, keeps the progress, and the first browser sees "Setup continued in another browser." That use prints another replacement, and so on.

## How it is protected

- The code is 128 random bits and works once. The server keeps only its SHA-256 digest and compares digests in constant time. (A slow password hash such as Argon2id was ruled out on purpose: a 128-bit code cannot be guessed anyway, and a memory-heavy hash on a public page would let anyone exhaust the server's memory.)
- Setup requests must come from the setup page itself (matching `Origin`, and `POLYNOVEA_PUBLIC_URL` when set) over HTTPS or loopback. Refusals give one generic message; the reason goes to the server log.
- Setup responses are never cached, never send a referrer and cannot be shown inside another site's frame.
