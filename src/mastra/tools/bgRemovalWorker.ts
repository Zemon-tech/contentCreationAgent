/**
 * Background-removal worker — runs @imgly/background-removal-node in its OWN
 * process so the onnxruntime native layer never shares an address space with
 * sharp's libvips. Running both in one process causes a native access
 * violation on Windows (GLib/GObject crash); isolating the model fixes it.
 *
 * Protocol (kept dead simple, binary over stdio):
 *   stdin  : the input PNG bytes (already normalised to PNG by the caller)
 *   argv[2]: model name ("small" | "medium")
 *   stdout : the cutout PNG bytes on success
 *   exit 0 : success (stdout holds the PNG)
 *   exit 1 : failure (stderr holds the message); caller falls back
 *
 * Invoked by makeHeroCutout() via child_process; not a user-facing tool.
 */

import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removeBackground } from "@imgly/background-removal-node";

function imglyPublicPath(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve("@imgly/background-removal-node");
  return pathToFileURL(path.dirname(entry) + path.sep).href;
}

function readStdin(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer | string) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    );
    process.stdin.on("end", () => resolve(Buffer.concat(chunks)));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const model = process.argv[2] === "small" ? "small" : "medium";
  const input = await readStdin();
  if (input.length === 0) throw new Error("empty input on stdin");

  const blob = await removeBackground(new Blob([new Uint8Array(input)], { type: "image/png" }), {
    model,
    output: { format: "image/png" },
    publicPath: imglyPublicPath(),
  });
  const out = Buffer.from(await blob.arrayBuffer());
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(out, (err) => (err ? reject(err) : resolve())),
  );
}

main().catch((e) => {
  process.stderr.write(String(e?.stack ?? e));
  process.exit(1);
});
