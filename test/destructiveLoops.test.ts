import assert from "node:assert";
// Drives the REAL destructive loops in src/main.ts against a fake vault. The pure
// core is covered elsewhere; these are the Obsidian-bound orchestration paths no
// pure test can reach, and where the 1.3.3 review found its worst bugs.
import AttachmentManagerPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/core/settings/defaults";
import { notices } from "./obsidian-stub";
import type { AttachmentIssue } from "../src/types";

interface FakeFile {
  path: string;
  stat: { size: number; mtime: number };
}

interface Gate {
  eligible: Set<string>;
  mentioned: Set<string>;
  epoch: number;
}

type Plugin = Record<string, unknown> & {
  settings: typeof DEFAULT_SETTINGS;
  mutationEpoch: number;
};

/** A plugin instance wired to an in-memory vault, without running onload. */
function harness(paths: string[]) {
  const files = new Map<string, FakeFile>();
  for (const p of paths) files.set(p, { path: p, stat: { size: 100, mtime: 1 } });
  // File bytes, for the code paths that hash (duplicate re-proof).
  const contents = new Map<string, string>();
  let saveShouldFail = false;
  // Paths a source now references (by content), as the live gate would see them.
  const mentionedNow = new Set<string>();

  const plugin = Object.create(AttachmentManagerPlugin.prototype as object) as Plugin;
  Object.assign(plugin, {
    settings: structuredClone(DEFAULT_SETTINGS),
    mutationEpoch: 0,
    unloaded: false,
    scanning: false,
    ignoredSet: new Set<string>(),
    reviewedSet: new Set<string>(),
    saveTimer: null,
    lastResult: null,
    app: {
      vault: {
        getFileByPath: (p: string) => files.get(p) ?? null,
        getConfig: () => "local",
        adapter: {
          readBinary: (p: string) =>
            Promise.resolve(new TextEncoder().encode(contents.get(p) ?? "").buffer),
        },
      },
      fileManager: {
        trashFile: (f: FakeFile) => {
          files.delete(f.path);
          return Promise.resolve();
        },
      },
    },
    saveData: () =>
      saveShouldFail ? Promise.reject(new Error("disk full")) : Promise.resolve(),
    // The live gate as the real one computes it: snapshot the epoch FIRST, then
    // report what is mentioned right now.
    openTrashGate: (ps: string[]): Promise<Gate> => {
      const epoch = plugin.mutationEpoch;
      return Promise.resolve({
        eligible: new Set(ps.filter((p) => files.has(p))),
        mentioned: new Set([...mentionedNow]),
        epoch,
      });
    },
    maybeHashFile: () => Promise.resolve({ head: "hash", full: "full" }),
    refreshViews: () => {},
  });
  return {
    plugin,
    files,
    contents,
    mentionedNow,
    setSaveFails: (v: boolean) => {
      saveShouldFail = v;
    },
  };
}

const issue = (p: string): AttachmentIssue => ({
  id: `${p}\nunused`,
  attachmentPath: p,
  attachmentName: p.slice(p.lastIndexOf("/") + 1),
  issueType: "unused",
  severity: 3,
  reason: "unused",
  sizeBytes: 100,
});

type Loop = (paths: string[], gate: Gate, issues: AttachmentIssue[], single: boolean) => Promise<string[]>;
const loopOf = (plugin: Plugin): Loop => (plugin.trashGatedPaths as Loop).bind(plugin);
const freshGate = (paths: string[]): Gate => ({
  eligible: new Set(paths),
  mentioned: new Set<string>(),
  epoch: 0,
});

async function run(): Promise<void> {
  // --- A source edited DURING the pre-trash hash read ------------------------
  // The gate used to be checked before `maybeHashFile` awaited, so a note that
  // started referencing the file during that read bumped the epoch AFTER the
  // check, and the stale verdict was used for the trash.
  {
    const h = harness(["assets/old.png"]);
    h.plugin.maybeHashFile = () => {
      h.mentionedNow.add("assets/old.png");
      h.plugin.mutationEpoch++; // what the vault `modify` listener does
      return Promise.resolve({ head: "hash", full: "full" });
    };
    const out = await loopOf(h.plugin)(
      ["assets/old.png"],
      freshGate(["assets/old.png"]),
      [issue("assets/old.png")],
      false
    );
    assert.deepStrictEqual(out, [], "a file referenced during the hash read is not trashed");
    assert.ok(h.files.has("assets/old.png"));
  }

  // --- Ordinary batch: nothing changes, everything goes ----------------------
  {
    const h = harness(["a.png", "b.png"]);
    const out = await loopOf(h.plugin)(
      ["a.png", "b.png"],
      freshGate(["a.png", "b.png"]),
      [issue("a.png"), issue("b.png")],
      false
    );
    assert.deepStrictEqual(out, ["a.png", "b.png"]);
    assert.strictEqual(h.plugin.settings.journal.length, 1, "the batch is recorded");
    assert.strictEqual(h.plugin.settings.journal[0].entries.length, 2);
    assert.strictEqual(h.plugin.settings.journal[0].entries[0].fullHash, "full", "the whole-file hash is recorded");
    assert.strictEqual(h.plugin.settings.journal[0].entries[0].headHash, "hash");
  }

  // --- A vault that never holds still is not trashed on a stale verdict ------
  {
    const h = harness(["a.png"]);
    const realGate = h.plugin.openTrashGate as (ps: string[]) => Promise<Gate>;
    h.plugin.openTrashGate = async (ps: string[]) => {
      const g = await realGate(ps);
      h.plugin.mutationEpoch++; // another change lands during every re-check
      return g;
    };
    h.plugin.mutationEpoch = 1;
    const out = await loopOf(h.plugin)(["a.png"], freshGate(["a.png"]), [issue("a.png")], false);
    assert.deepStrictEqual(out, [], "an unverifiable file is skipped, not trashed");
    assert.ok(h.files.has("a.png"));
  }

  // --- History cannot be written at all: nothing is touched -----------------
  // A batch smaller than the flush interval used to finish every mutation before
  // its first write was attempted, so a read-only or full disk left the whole
  // action without an undo record. The write is now proven before anything moves.
  {
    const paths = ["s1.png", "s2.png", "s3.png"];
    const h = harness(paths);
    h.setSaveFails(true);
    notices.length = 0;
    const out = await loopOf(h.plugin)(paths, freshGate(paths), paths.map(issue), false);
    assert.deepStrictEqual(out, [], "nothing is trashed when history cannot be saved");
    assert.strictEqual(h.files.size, 3);
    assert.ok(
      notices.some((n) => n.includes("nothing was changed")),
      `the user is told: ${JSON.stringify(notices)}`
    );
  }

  // --- History write starts failing mid-action: stop after one file, say so ---
  {
    const paths = Array.from({ length: 60 }, (_, i) => `f${i}.png`);
    const h = harness(paths);
    let calls = 0;
    h.plugin.saveData = () =>
      ++calls === 1 ? Promise.resolve() : Promise.reject(new Error("disk full"));
    notices.length = 0;
    const out = await loopOf(h.plugin)(paths, freshGate(paths), paths.map(issue), false);
    assert.strictEqual(out.length, 1, `stops at the first failed write (trashed ${out.length})`);
    assert.ok(
      notices.some((n) => n.includes("could not be saved")),
      `the user is told: ${JSON.stringify(notices)}`
    );
  }

  // --- History write fails once, then the closing retry succeeds -------------
  // The batch still stops (it cannot know the next write will work), but it must
  // not claim the files are unrestorable: everything IS recorded.
  {
    const paths = Array.from({ length: 40 }, (_, i) => `r${i}.png`);
    const h = harness(paths);
    let calls = 0;
    h.plugin.saveData = () =>
      ++calls === 2 ? Promise.reject(new Error("transient")) : Promise.resolve();
    notices.length = 0;
    const out = await loopOf(h.plugin)(paths, freshGate(paths), paths.map(issue), false);
    assert.strictEqual(out.length, 1, "stopped at the failed write");
    assert.ok(!notices.some((n) => n.includes("may not be restorable")), JSON.stringify(notices));
    assert.ok(notices.some((n) => n.includes("Everything done so far is recorded")));
    assert.strictEqual(h.plugin.settings.journal[0].entries.length, 1);
  }

  // --- History write succeeds: no false alarm --------------------------------
  {
    const paths = Array.from({ length: 30 }, (_, i) => `g${i}.png`);
    const h = harness(paths);
    notices.length = 0;
    const out = await loopOf(h.plugin)(paths, freshGate(paths), paths.map(issue), false);
    assert.strictEqual(out.length, 30);
    assert.ok(!notices.some((n) => n.includes("could not be saved")));
  }

  // --- Duplicate copies: the survivor must still BE a duplicate --------------
  // Cluster membership is a scan-time fact. A survivor rewritten after the scan
  // (another device, an external editor) used to count as "a copy is kept"
  // merely because it existed, and the last copy of the original was trashed.
  {
    const sha = async (text: string): Promise<string> => {
      const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
      return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
    };
    const cluster = await sha("PIXELS");
    const dup = (p: string): AttachmentIssue => ({
      ...issue(p),
      id: `${p}
duplicate`,
      issueType: "duplicate",
      clusterId: cluster,
    });
    const setup = (survivorBytes = "PIXELS") => {
      const h = harness(["a.png", "b.png"]);
      h.contents.set("a.png", "PIXELS");
      h.contents.set("b.png", survivorBytes);
      Object.assign(h.plugin, {
        lastResult: {
          issues: [dup("a.png"), dup("b.png")],
          totalFiles: 2,
          scannedAt: "2026-01-01T00:00:00.000Z",
        },
        inboundMap: () => new Map<string, number>(),
        // Only `a.png` is unused, so `b.png` is the would-be survivor.
        unusedPathSet: () => new Set(["a.png"]),
      });
      return h;
    };
    const trashDupes = (h: ReturnType<typeof harness>, sel = [dup("a.png")]) =>
      (h.plugin.bulkTrashDuplicateCopies as (s: AttachmentIssue[]) => Promise<string[]>).call(
        h.plugin,
        sel
      );

    const intact = setup();
    assert.deepStrictEqual(await trashDupes(intact), ["a.png"], "an intact survivor allows the trash");

    // Same size, same mtime, different bytes: only a content check can see it.
    const swapped = setup("PIXELZ");
    assert.deepStrictEqual(await trashDupes(swapped), [], "a survivor with different bytes is no survivor");
    assert.ok(swapped.files.has("a.png"));

    const gone = setup();
    gone.files.delete("b.png");
    assert.deepStrictEqual(await trashDupes(gone), [], "a deleted survivor is no survivor");

    // The survivor is edited DURING the gate's awaited mention scan — after the
    // content proof passed. The per-file synchronous re-check must catch it.
    const racing = setup();
    const realGate = racing.plugin.openTrashGate as (ps: string[]) => Promise<Gate>;
    racing.plugin.openTrashGate = async (ps: string[]) => {
      const g = await realGate(ps);
      racing.files.get("b.png")!.stat.mtime = 5000; // edited mid-gate
      return g;
    };
    assert.deepStrictEqual(await trashDupes(racing), [], "a survivor edited mid-gate is caught");
    assert.ok(racing.files.has("a.png"));

    // The survivor's bytes are swapped — same size, same mtime — AFTER the
    // up-front proof (here: during the gate's mention scan). Only re-hashing
    // right before the trash can see it.
    const swappedLate = setup();
    const realGate2 = swappedLate.plugin.openTrashGate as (ps: string[]) => Promise<Gate>;
    swappedLate.plugin.openTrashGate = async (ps: string[]) => {
      const g = await realGate2(ps);
      swappedLate.contents.set("b.png", "PIXELZ");
      return g;
    };
    assert.deepStrictEqual(await trashDupes(swappedLate), [], "a late same-stat swap is caught by content");
    assert.ok(swappedLate.files.has("a.png"));

    // Both copies selected and unused: exactly one goes, one stays.
    const both = setup();
    Object.assign(both.plugin, { unusedPathSet: () => new Set(["a.png", "b.png"]) });
    const out = await trashDupes(both, [dup("a.png"), dup("b.png")]);
    assert.strictEqual(out.length, 1, "keep-one still holds under the live re-proof");
    assert.strictEqual(both.files.size, 1);
  }

  // --- A file modified while its hash was being read is not trashed ----------
  // Its hash would describe bytes that no longer exist, so the restore could
  // never identify it again.
  {
    const h = harness(["m.png"]);
    h.plugin.maybeHashFile = () => {
      h.files.get("m.png")!.stat.mtime = 999; // same TFile, new content
      return Promise.resolve({ head: "old", full: "old" });
    };
    const out = await loopOf(h.plugin)(["m.png"], freshGate(["m.png"]), [issue("m.png")], false);
    assert.deepStrictEqual(out, []);
    assert.ok(h.files.has("m.png"));
  }

  // --- Single rename: same guards as bulk move -------------------------------
  {
    const renamed: string[] = [];
    const wire = (h: ReturnType<typeof harness>) => {
      Object.assign(h.plugin.app as object, {
        fileManager: {
          renameFile: (f: FakeFile, to: string) => {
            renamed.push(to);
            h.files.delete(f.path);
            h.files.set(to, { ...f, path: to });
            return Promise.resolve();
          },
        },
      });
      h.plugin.pathExistsCI = (p: string) => h.files.has(p);
      return (h.plugin.renameAttachment as (p: string, n: string) => Promise<string | null>).bind(
        h.plugin
      );
    };

    const ok = harness(["img/a.png"]);
    assert.strictEqual(await wire(ok)("img/a.png", "b"), "img/b.png");
    assert.strictEqual(ok.plugin.settings.journal.length, 1, "the rename is recorded");

    // History cannot be written: no rename.
    const ro = harness(["img/a.png"]);
    ro.setSaveFails(true);
    renamed.length = 0;
    assert.strictEqual(await wire(ro)("img/a.png", "b"), null);
    assert.deepStrictEqual(renamed, [], "nothing is renamed without an undo record");

    // Edited while its hash was read: no rename.
    const racing = harness(["img/a.png"]);
    racing.plugin.maybeHashFile = () => {
      racing.files.get("img/a.png")!.stat.mtime = 4242;
      return Promise.resolve({ head: "h", full: "f" });
    };
    renamed.length = 0;
    assert.strictEqual(await wire(racing)("img/a.png", "b"), null);
    assert.deepStrictEqual(renamed, []);
  }

  console.log("destructiveLoops tests passed");
}

export const done = run();
