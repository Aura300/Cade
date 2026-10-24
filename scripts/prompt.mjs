// Asking for secrets in the terminal without showing them, for npm run dev.
import { createInterface } from "node:readline";

// Asks a question without showing what's typed, for tokens and secrets.
export function askHidden(question) {
  return new Promise((resolve) => {
    const prompt = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    prompt._writeToOutput = (text) => {
      // Echo the question and the final line break, not the answer.
      if (text.startsWith(question) || text === "\r\n" || text === "\n") process.stdout.write(text);
    };
    prompt.question(question, (answer) => {
      prompt.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}
