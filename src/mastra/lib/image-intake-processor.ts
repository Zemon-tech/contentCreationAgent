/**
 * imageIntakeProcessor — routes chat-attached images AWAY from the LLM and
 * INTO the Flux inbox (so they reach ComfyUI as references).
 *
 * WHY: Sarvam (text-only, OpenAI-compatible) rejects any chat message whose
 * `content` is an array instead of a plain string:
 *   400 body.messages.N.user.content : Input should be a valid string
 * Images pasted in Mastra Studio are meant for Flux/ComfyUI only, never the LLM.
 *
 * HOW: `processLLMRequest` runs on the FINAL provider prompt, right before it
 * is sent to the model (and does not alter stored memory). For every user
 * message it:
 *   1. pulls out image `file` parts and saves their bytes into the Flux inbox
 *      (deduplicated by content hash, so history re-sent on later turns is not
 *      re-saved),
 *   2. collapses the remaining text parts into ONE text part — the
 *      OpenAI-compatible provider then serialises content as a plain string,
 *   3. appends a note telling the agent the image is waiting in the inbox.
 * The agent then calls useInboxReferences to upload it to the ComfyUI VM.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { InputProcessor } from "@mastra/core/processors";
import { fluxInboxDir } from "./flux-paths";

const MAX_BYTES = 20 * 1024 * 1024;

/** Shared with flux-tools and the paste page (resolved from the project root). */
const inboxDir = fluxInboxDir;

function extFromMime(mime: string | undefined): string {
  if (!mime) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  return "png";
}

/** Converts a prompt file-part payload (bytes / base64 / data URI / URL) to bytes. */
async function toBytes(data: unknown): Promise<{ bytes: Buffer; mime?: string } | null> {
  if (data instanceof Uint8Array) return { bytes: Buffer.from(data) };
  if (data instanceof ArrayBuffer) return { bytes: Buffer.from(new Uint8Array(data)) };
  if (data instanceof URL) data = data.href;
  if (typeof data !== "string") return null;
  const str = data.trim();

  const dataUri = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(str);
  if (dataUri) {
    const raw = dataUri[3] ?? "";
    const bytes = dataUri[2] ? Buffer.from(raw, "base64") : Buffer.from(decodeURIComponent(raw), "utf-8");
    return { bytes, mime: dataUri[1] };
  }
  if (/^https?:\/\//i.test(str)) {
    try {
      const res = await fetch(str, { redirect: "follow" });
      if (!res.ok) return null;
      return { bytes: Buffer.from(await res.arrayBuffer()), mime: res.headers.get("content-type") ?? undefined };
    } catch {
      return null;
    }
  }
  // Plain base64 (the usual shape of prompt file parts).
  if (/^[A-Za-z0-9+/=\s]+$/.test(str)) {
    return { bytes: Buffer.from(str.replace(/\s+/g, ""), "base64") };
  }
  return null;
}

export const imageIntakeProcessor: InputProcessor = {
  id: "flux-image-intake",
  name: "Flux image intake",
  description:
    "Diverts chat-attached images to the Flux inbox (for ComfyUI) and sends only plain-text content to the text-only LLM.",

  async processLLMRequest({ prompt }) {
    let changed = false;

    const newPrompt = await Promise.all(
      prompt.map(async (message) => {
        if (message.role !== "user" || !Array.isArray(message.content)) return message;

        const texts: string[] = [];
        const savedNames: string[] = [];
        let hadNonText = false;

        for (const part of message.content as any[]) {
          if (part?.type === "text") {
            texts.push(part.text ?? "");
            continue;
          }
          hadNonText = true;
          const mediaType: string | undefined = part?.mediaType ?? part?.mimeType;
          if (part?.type !== "file" || (mediaType && !mediaType.startsWith("image/"))) continue;

          const resolved = await toBytes(part.data);
          if (!resolved || resolved.bytes.length === 0 || resolved.bytes.length > MAX_BYTES) continue;

          // Content-addressed name: the same image always maps to the same file,
          // so re-pasting or replayed history never duplicates it, and a file
          // that was cleaned up is simply written again.
          const hash = createHash("sha1").update(resolved.bytes).digest("hex").slice(0, 16);
          const name = `chat_${hash}.${extFromMime(resolved.mime ?? mediaType)}`;
          const dir = inboxDir();
          const full = path.join(dir, name);
          if (!fs.existsSync(full)) {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(full, resolved.bytes);
          }
          savedNames.push(name);
        }

        // Nothing to fix: a single text part already serialises as a string.
        if (!hadNonText && texts.length <= 1) return message;

        changed = true;
        let text = texts.join("\n\n").trim();
        if (savedNames.length > 0) {
          text +=
            `\n\n[Attached image(s) saved to the Flux inbox for ComfyUI (not sent to you): ` +
            `${savedNames.join(", ")}. Call useInboxReferences with fileNames=${JSON.stringify(savedNames)} ` +
            `to load them as references, then generateFluxImage.]`;
        }
        return { ...message, content: [{ type: "text" as const, text: text.trim() || "(image attached)" }] };
      }),
    );

    return changed ? { prompt: newPrompt as typeof prompt } : undefined;
  },
};
