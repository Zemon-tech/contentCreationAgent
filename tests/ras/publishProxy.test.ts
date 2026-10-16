import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublishServer, resolvePublishFile } from "../../src/mastra/demo/publishProxy";

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pub-"));
  fs.mkdirSync(path.join(root, "ras", "my-post"), { recursive: true });
  fs.writeFileSync(path.join(root, "ras", "my-post", "01.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
  fs.writeFileSync(path.join(root, "ras", "my-post", "01.png"), "png");
  fs.writeFileSync(path.join(root, "secret.txt"), "top secret");
  return root;
}

test("resolves only /ras-publish/<slug>/<file>.jpg and blocks traversal", () => {
  const root = setup();
  assert.ok(resolvePublishFile("/ras-publish/my-post/01.jpg", root)!.endsWith(path.join("my-post", "01.jpg")));
  assert.equal(resolvePublishFile("/ras-publish/my-post/01.png", root), null); // jpg only
  assert.equal(resolvePublishFile("/ras-publish/../secret.txt", root), null);
  assert.equal(resolvePublishFile("/ras-publish/my-post/..%2f..%2fsecret.txt", root), null);
  assert.equal(resolvePublishFile("/api/agents", root), null); // nothing else is served
});

test("server: 200 image/jpeg for a post, 404 for everything else, 405 for non-GET", async () => {
  const root = setup();
  const server = createPublishServer(root);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const get = (p: string, method = "GET") => fetch(`http://127.0.0.1:${port}${p}`, { method });
  try {
    const ok = await get("/ras-publish/my-post/01.jpg");
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/jpeg");
    assert.equal((await get("/ras-publish/my-post/01.jpg", "HEAD")).status, 200);
    assert.equal((await get("/ras-publish/my-post/01.png")).status, 404);
    assert.equal((await get("/secret.txt")).status, 404);
    assert.equal((await get("/api/agents")).status, 404);
    assert.equal((await get("/ras-publish/my-post/01.jpg", "POST")).status, 405);
  } finally { server.close(); }
});
