import { validateHtml } from "./html.js";
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
try {
  validateHtml(Buffer.concat(chunks));
  process.stdout.write(JSON.stringify({ ok: true }));
} catch (error: any) {
  process.stdout.write(
    JSON.stringify({
      statusCode: error.statusCode || 400,
      message: error.message,
    }),
  );
}
