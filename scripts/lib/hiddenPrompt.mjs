import readline from "node:readline";

/**
 * Asks for a secret in the terminal without echoing it (it never reaches shell history or the process
 * list). Resolves to "" when there is no terminal to ask in.
 * @param {string} question
 * @param {{ input?: NodeJS.ReadStream, output?: NodeJS.WriteStream }} [streams]
 * @returns {Promise<string>}
 */
export function promptHidden(question, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return Promise.resolve("");
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    output.write(question);
    // Mute readline's echo of the typed characters.
    /** @type {any} */ (rl)._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      output.write("\n");
      resolve(answer);
    });
  });
}
