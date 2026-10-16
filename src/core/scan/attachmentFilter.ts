// Pure attachment classification. No Obsidian API — runs in tests under Node.
//
// An "attachment" is any vault file that is NOT an editable Obsidian document
// (markdown / canvas / base). Those three are how you REFERENCE attachments, so
// they are scanned as sources, never treated as attachments themselves.

/** Extensions that are Obsidian documents, not attachments. */
export const NON_ATTACHMENT_EXTENSIONS = new Set(["md", "canvas", "base"]);

/** Lower-cased extension without the dot, or "" when there is none. */
export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return ""; // no extension, or a dotfile like ".gitignore"
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Extensions that are RECOGNISABLY attachments, used only where a false positive
 * is pure noise rather than a missed file.
 *
 * {@link isAttachment} deliberately does NOT consult this list: a real file in
 * the vault with an exotic extension is still an attachment we should manage, and
 * "not a document" is the right rule there. But the broken-link detector works
 * on LINK TEXT, where "has a dot" is not evidence of anything — `[[2024.01.15]]`,
 * `[[v1.2 plan]]` and `[[Dr. Smith notes]]` all have an "extension" by that rule
 * (`15`, `2 plan`, ` Smith notes`) and were every one of them reported as a
 * broken attachment on every scan. Dotted daily notes and forward links to
 * not-yet-created notes are completely ordinary Obsidian usage, so that filter
 * produced guaranteed, permanent noise.
 *
 * Erring the other way is cheap here: a broken link is reported, never acted on
 * (`exists: false`), so missing one costs a line in a list, while inventing one
 * costs the user's trust in the whole report.
 */
export const KNOWN_ATTACHMENT_EXTENSIONS = new Set([
  // images
  "png", "jpg", "jpeg", "jfif", "gif", "bmp", "svg", "svgz", "webp", "avif",
  "heic", "heif", "tiff", "tif", "ico", "psd", "ai", "eps", "xcf",
  // audio
  "mp3", "wav", "wave", "m4a", "ogg", "oga", "opus", "flac", "aac", "aiff", "aif",
  "wma", "mid", "midi",
  // video
  "mp4", "m4v", "webm", "mov", "mkv", "avi", "ogv", "wmv", "flv", "mpg", "mpeg",
  "3gp",
  // documents
  "pdf", "epub", "mobi", "azw3", "djvu", "ps", "xps",
  // office / productivity
  "doc", "docx", "dot", "dotx", "xls", "xlsx", "xlsm", "ppt", "pptx", "pps",
  "odt", "ods", "odp", "rtf", "pages", "numbers", "key",
  // archives
  "zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "xz", "zst",
  // text / data / markup
  "txt", "text", "csv", "tsv", "json", "jsonc", "json5", "yaml", "yml", "toml",
  "ini", "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts",
  "log", "opml", "bib", "tex", "srt", "vtt", "url", "webloc",
  // drawing / 3D / design / fonts
  "excalidraw", "drawio", "puml", "mermaid", "mmd", "sketch", "fig", "blend",
  "stl", "obj", "fbx", "gltf", "glb", "dwg", "dxf",
  "ttf", "otf", "woff", "woff2", "eot",
  // code people attach
  "py", "rb", "sh", "bat", "ps1", "sql", "ipynb", "r", "go", "rs", "java", "c",
  "h", "cpp", "cs", "swift", "kt", "lua", "php",
]);

/**
 * True when a path should be treated as an attachment: it has an extension and
 * that extension is not a document type. `extraExtensions` is currently only a
 * forward-compatibility hook (all non-document files are already included).
 */
export function isAttachment(path: string, extraExtensions: string[] = []): boolean {
  const ext = extensionOf(path);
  if (!ext) return false; // extension-less files aren't attachments we manage
  // The `extraExtensions` map below allocates an array per call, and this runs
  // once per vault file. Only document extensions can ever consult it, so the
  // overwhelmingly common case must not pay for it.
  if (NON_ATTACHMENT_EXTENSIONS.has(ext)) {
    // Allow a user to opt a document type back in (rare), via extras.
    return extraExtensions.map((e) => e.toLowerCase().replace(/^\./, "")).includes(ext);
  }
  return true;
}
