/**
 * Reference-image inbox drop server.
 *
 * A tiny local web page + endpoint so you can PASTE an image and have it land
 * in the Flux inbox folder. The imageGenAgent's `useInboxReferences` tool then
 * picks it up and uploads it to the ComfyUI VM as a reference.
 *
 * Run it:
 *   npm run inbox
 * Then open http://127.0.0.1:8790 and paste (Ctrl/Cmd+V) or drop an image.
 *
 * Env:
 *   FLUX_INBOX_DIR   where to write images (default workspace/flux/inbox)
 *   INBOX_PORT       port to listen on (default 8790)
 *
 * The inbox dir MUST match the one flux-tools uses (same FLUX_INBOX_DIR / default).
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { fluxInboxDir } from "../lib/flux-paths";

// Same folder the Studio intake processor and useInboxReferences use.
const INBOX_DIR = fluxInboxDir();
const PORT = Number(process.env.INBOX_PORT || 8790);

fs.mkdirSync(INBOX_DIR, { recursive: true });

function extFor(mime: string): string {
  if (mime.includes("png")) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Flux reference inbox</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#0B0C0C}
#drop{border:2px dashed #087FEA;border-radius:12px;padding:40px;text-align:center;color:#555;background:#F3EFE5}
#drop.hi{background:#e7f0ff}.row{margin:14px 0}img.prev{max-width:120px;border-radius:8px;margin:6px;border:1px solid #ccc}
code{background:#eee;padding:2px 6px;border-radius:4px}</style></head>
<body>
<h2>Flux reference inbox</h2>
<p>Paste (<code>Ctrl/Cmd+V</code>) or drop an image below. It is saved to the inbox and shipped to ComfyUI when you ask the agent to use it.</p>
<div id="drop">Click here, then paste — or drop an image file</div>
<div class="row" id="status"></div>
<div class="row" id="thumbs"></div>
<script>
const drop=document.getElementById('drop'),status=document.getElementById('status'),thumbs=document.getElementById('thumbs');
drop.tabIndex=0;drop.focus();
async function send(blob){
  const fd=new FormData();fd.append('image',blob,'pasted');
  status.textContent='Uploading…';
  const r=await fetch('/drop',{method:'POST',body:fd});
  const j=await r.json();
  status.textContent=j.ok?('Saved: '+j.name):('Error: '+j.error);
  if(j.ok){const u=URL.createObjectURL(blob);const i=document.createElement('img');i.src=u;i.className='prev';thumbs.appendChild(i);}
}
window.addEventListener('paste',e=>{for(const it of e.clipboardData.items){if(it.type.startsWith('image/')){send(it.getAsFile());}}});
drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('hi');});
drop.addEventListener('dragleave',()=>drop.classList.remove('hi'));
drop.addEventListener('drop',e=>{e.preventDefault();drop.classList.remove('hi');for(const f of e.dataTransfer.files){if(f.type.startsWith('image/'))send(f);}});
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }

  if (req.method === "POST" && req.url === "/drop") {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks);
      const contentType = req.headers["content-type"] || "";

      let bytes: Buffer;
      let mime = "image/png";

      if (contentType.startsWith("multipart/form-data")) {
        // Minimal multipart parse: find the file part payload between boundaries.
        const boundary = "--" + contentType.split("boundary=")[1];
        const parts = raw.toString("latin1").split(boundary);
        const filePart = parts.find((p) => p.includes("Content-Type: image/"));
        if (!filePart) throw new Error("No image part in upload.");
        const mimeMatch = /Content-Type:\s*(image\/[\w.+-]+)/i.exec(filePart);
        if (mimeMatch) mime = mimeMatch[1];
        const headerEnd = filePart.indexOf("\r\n\r\n");
        const body = filePart.slice(headerEnd + 4).replace(/\r\n$/, "");
        bytes = Buffer.from(body, "latin1");
      } else {
        // Raw body (e.g. curl --data-binary) — trust the Content-Type.
        if (contentType.startsWith("image/")) mime = contentType;
        bytes = raw;
      }

      const name = `paste_${randomUUID().slice(0, 8)}.${extFor(mime)}`;
      fs.writeFileSync(path.join(INBOX_DIR, name), bytes);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, name, dir: INBOX_DIR }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: false, error: "Not found" }));
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[inbox] drop server on http://127.0.0.1:${PORT}`);
  console.log(`[inbox] writing images to ${INBOX_DIR}`);
  console.log(`[inbox] open the page, paste an image, then tell the agent to "use the pasted reference".`);
});
