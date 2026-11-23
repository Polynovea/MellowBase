// Implementation lives in configStore.mjs so plain-Node scripts (run-migrations.mjs, the CLI) read
// config.enc with exactly the same code as the app. Types, including InstallConfig, come with it.
export * from "./configStore.mjs";
