# Setup wizard

A fresh server becomes a secured CMS from the browser. Until setup is finished the CMS serves only
the wizard at `/setup`; afterwards `/setup` is gone for good.

1. [Setup code](setup-code.md): the one-time code printed to the server log, and how to supply your
   own for automated deploys.
2. [Database](database.md): "On this server", "Existing managed database" or "Created for you",
   and the checks each one runs.
3. [Owner account](owner.md): the first owner, two-step sign-in and recovery codes.
4. [Modes and keys](modes-and-keys.md): setup, running and unavailable modes, the master key,
   `config.enc` and key rotation.
