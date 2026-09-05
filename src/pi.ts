import fs from "node:fs/promises";
import path from "node:path";

const SCREENSHOT_KINDS = new Set([
  "proof",
  "question",
  "debug",
  "screenshot",
  "captcha",
]);
const IMAGE_MIME_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".gif", "image/gif"],
]);

function artifactImagePath(artifact) {
  const media = String(artifact?.media || "");
  const isMedia = media.startsWith("MEDIA:");
  const candidate = isMedia ? media.slice("MEDIA:".length) : String(artifact?.path || "");
  const mimeType = IMAGE_MIME_TYPES.get(path.extname(candidate).toLowerCase());
  if (!path.isAbsolute(candidate) || !mimeType) return null;
  const kind = String(artifact?.kind || "");
  if (!isMedia && !SCREENSHOT_KINDS.has(kind)) return null;
  return { path: candidate, mimeType, kind, inline: inlineImagePath(artifact) };
}

// The downscaled model-facing companion of a proof screenshot, when the worker
// wrote one. Validated like any other artifact path before it is trusted.
function inlineImagePath(artifact) {
  const candidate = String(artifact?.inlinePath || "");
  const mimeType = IMAGE_MIME_TYPES.get(path.extname(candidate).toLowerCase());
  if (!path.isAbsolute(candidate) || !mimeType) return null;
  return { path: candidate, mimeType };
}

function dedupedImages(result) {
  const images = [];
  const seen = new Set();
  for (const artifact of result?.artifacts || []) {
    const image = artifactImagePath(artifact);
    if (!image || seen.has(image.path)) continue;
    seen.add(image.path);
    images.push(image);
  }
  return images;
}

/** Return safe, local image artifacts that Pi can receive as vision input. */
export function piImageArtifacts(result) {
  return dedupedImages(result).map((image) =>
    image.inline
      ? { path: image.inline.path, mimeType: image.inline.mimeType }
      : { path: image.path, mimeType: image.mimeType },
  );
}

/** Select the screenshot that best represents the browser step in a trace. */
export function piPrimaryImageArtifact(result) {
  const images = dedupedImages(result);
  const selected = images.findLast((image) => image.kind !== "captcha") || images.at(-1);
  return selected ? { path: selected.path, mimeType: selected.mimeType } : null;
}

/** Convert BetterWright screenshot artifacts to Pi AgentToolResult image blocks. */
export async function piImageContent(
  result,
  { maxImageBytes = 2_500_000 }: any = {},
) {
  const content = [];
  for (const image of piImageArtifacts(result)) {
    try {
      const stat = await fs.stat(image.path);
      if (!stat.isFile() || stat.size > maxImageBytes) continue;
      const data = (await fs.readFile(image.path)).toString("base64");
      content.push({ type: "image", data, mimeType: image.mimeType });
    } catch {
      // A deleted or unreadable screenshot should not fail the browser result.
    }
  }
  return content;
}
