// Pure filename sanitizing for the rename action. No Obsidian API — runs in tests.
//
// A bad name here does not throw, it CORRUPTS: Windows silently strips trailing
// dots and spaces, so `renameFile(f, "foo. ")` leaves Obsidian's index pointing at
// a path the filesystem never created, and every later lookup for that file fails.
// Reserved device names are worse — the rename fails outright, mid-batch.

/**
 * Windows reserved device names. These are reserved with ANY extension, so
 * `nul.old.png` still resolves to the NUL device — the check must run against the
 * stem before the FIRST dot, not the whole name.
 */
const RESERVED_DEVICE_NAMES =
  /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]|conin\$|conout\$)$/i;

/** Characters no major filesystem accepts in a name. */
const ILLEGAL_CHARS = /[\\/:*?"<>|]/g;

export interface SanitizedName {
  /** The cleaned basename, or null when nothing usable remained. */
  name: string | null;
  /** Why the name was rejected, phrased for a Notice. */
  reason?: string;
}

/**
 * Clean a user-entered basename (no extension) into something safe to write on
 * Windows, macOS and Linux, or reject it with a reason.
 */
export function sanitizeBaseName(input: string): SanitizedName {
  // Drop control characters (C0 and DEL) without using a control-char regex,
  // which the lint config forbids.
  const cleaned = Array.from(input.trim())
    .filter((c) => {
      const code = c.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(ILLEGAL_CHARS, "")
    // Windows silently drops trailing dots and spaces; strip them ourselves so
    // the path we record is the path that actually exists.
    .replace(/[. ]+$/, "")
    .trim();

  if (!cleaned) return { name: null, reason: "Enter a valid name." };

  // Reserved names apply to the stem regardless of extension.
  const stem = cleaned.split(".")[0];
  if (RESERVED_DEVICE_NAMES.test(stem)) {
    return { name: null, reason: `"${stem}" is a reserved device name on Windows.` };
  }

  // 255 bytes is the common per-component limit; leave room for an extension and
  // a " (2)" collision suffix.
  if (cleaned.length > 200) {
    return { name: null, reason: "That name is too long — keep it under 200 characters." };
  }

  return { name: cleaned };
}
