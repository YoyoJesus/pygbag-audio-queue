import { describe, it, expect, vi, beforeEach } from "vitest";
import { AudioManager } from "./audio_manager";

// ── Mock HTMLAudioElement ────────────────────────────────────────────────────
// Each instantiation produces a fresh object with independent vi.fn() spies.

function makeMockAudio() {
  return {
    src: "",
    volume: 1,
    loop: false,
    currentTime: 0,
    play: vi.fn().mockResolvedValue(undefined),
    pause: vi.fn(),
    load: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    removeAttribute: vi.fn(),
  };
}

const MockAudio = vi.fn().mockImplementation(makeMockAudio);
vi.stubGlobal("Audio", MockAudio);

vi.stubGlobal("URL", {
  createObjectURL: vi.fn((f: File) => `blob:mock/${f.name}`),
  revokeObjectURL: vi.fn(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Return the mock audio element created on the nth Audio() call (0-indexed). */
function nthAudio(n = 0) {
  return MockAudio.mock.results[n].value as ReturnType<typeof makeMockAudio>;
}

/** Fake a File object with a given name. */
function fakeFile(name: string, type = "audio/ogg"): File {
  return new File([""], name, { type });
}

/**
 * jsdom marks HTMLInputElement.files as read-only; use defineProperty to
 * inject a plain array so _onFilesSelected can iterate over it.
 */
function setInputFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, "files", {
    value: files,
    writable: true,
    configurable: true,
  });
}

let manager: AudioManager;

beforeEach(() => {
  vi.clearAllMocks();
  // Clean up any upload elements injected into the DOM
  document.getElementById("typ0-upload-btn")?.remove();
  document
    .querySelectorAll('input[type="file"]')
    .forEach((el) => el.remove());
  manager = new AudioManager();
  // Simulate a user gesture so the autoplay-unlock gate is open for all tests
  window.dispatchEvent(new MouseEvent("click"));
});

// ── Volume ───────────────────────────────────────────────────────────────────

describe("getVolume / setVolume", () => {
  it("defaults to 0.7", () => {
    expect(manager.getVolume()).toBe(0.7);
  });

  it("sets a value between 0 and 1", () => {
    manager.setVolume(0.4);
    expect(manager.getVolume()).toBe(0.4);
  });

  it("clamps values below 0 to 0", () => {
    manager.setVolume(-0.5);
    expect(manager.getVolume()).toBe(0);
  });

  it("clamps values above 1 to 1", () => {
    manager.setVolume(1.5);
    expect(manager.getVolume()).toBe(1);
  });

  it("updates the volume of an active music element", () => {
    manager.playMusic("theme.ogg");
    manager.setVolume(0.3);
    expect(nthAudio(0).volume).toBe(0.3);
  });
});

// ── playMusic ────────────────────────────────────────────────────────────────

describe("playMusic", () => {
  it("creates an Audio element with the given URL", () => {
    manager.playMusic("assets/theme.ogg");
    expect(MockAudio).toHaveBeenCalledWith("assets/theme.ogg");
  });

  it("normalises Windows backslash paths", () => {
    manager.playMusic("assets\\theme.ogg");
    expect(MockAudio).toHaveBeenCalledWith("assets/theme.ogg");
  });

  it("passes blob URLs through unchanged", () => {
    manager.playMusic("blob:https://example.com/abc123");
    expect(MockAudio).toHaveBeenCalledWith("blob:https://example.com/abc123");
  });

  it("loops=−1 sets audio.loop to true", () => {
    manager.playMusic("theme.ogg", -1);
    expect(nthAudio(0).loop).toBe(true);
  });

  it("loops=0 does not loop", () => {
    manager.playMusic("theme.ogg", 0);
    expect(nthAudio(0).loop).toBe(false);
  });

  it("calls play() on the new element", () => {
    manager.playMusic("theme.ogg");
    expect(nthAudio(0).play).toHaveBeenCalledOnce();
  });

  it("applies current volume to the new element", () => {
    manager.setVolume(0.5);
    manager.playMusic("theme.ogg");
    expect(nthAudio(0).volume).toBe(0.5);
  });

  it("stops the previous track before starting a new one", () => {
    manager.playMusic("first.ogg");
    const first = nthAudio(0);
    manager.playMusic("second.ogg");
    expect(first.pause).toHaveBeenCalledOnce();
    expect(first.removeAttribute).toHaveBeenCalledWith("src");
    expect(first.load).toHaveBeenCalledOnce();
  });

  it("queues music when autoplay is still locked", () => {
    (manager as any)._unlocked = false;

    manager.playMusic("queued.ogg", 0);

    expect((manager as any)._pendingFile).toBe("queued.ogg");
    expect((manager as any)._pendingLoops).toBe(0);

    // Keep the shared window listeners from replaying this queued track in
    // later tests when the global click unlock fires again.
    (manager as any)._pendingFile = null;
    (manager as any)._unlocked = true;
  });
});

// ── stopMusic ────────────────────────────────────────────────────────────────

describe("stopMusic", () => {
  it("pauses and clears the active element", () => {
    manager.playMusic("theme.ogg");
    const audio = nthAudio(0);
    manager.stopMusic();
    expect(audio.pause).toHaveBeenCalledOnce();
    expect(audio.removeAttribute).toHaveBeenCalledWith("src");
    expect(audio.load).toHaveBeenCalledOnce();
  });

  it("is safe to call with no active music", () => {
    expect(() => manager.stopMusic()).not.toThrow();
  });
});

// ── pauseMusic / unpauseMusic ────────────────────────────────────────────────

describe("pauseMusic / unpauseMusic", () => {
  it("pauseMusic pauses the element", () => {
    manager.playMusic("theme.ogg");
    manager.pauseMusic();
    expect(nthAudio(0).pause).toHaveBeenCalledOnce();
  });

  it("calling pauseMusic twice only pauses once", () => {
    manager.playMusic("theme.ogg");
    manager.pauseMusic();
    manager.pauseMusic();
    expect(nthAudio(0).pause).toHaveBeenCalledOnce();
  });

  it("unpauseMusic calls play() after a pause", () => {
    manager.playMusic("theme.ogg");
    const audio = nthAudio(0);
    manager.pauseMusic();
    manager.unpauseMusic();
    // play() called once on playMusic, once on unpause
    expect(audio.play).toHaveBeenCalledTimes(2);
  });

  it("unpauseMusic does nothing when not paused", () => {
    manager.playMusic("theme.ogg");
    manager.unpauseMusic();
    expect(nthAudio(0).play).toHaveBeenCalledOnce();
  });
});

// ── User tracks ──────────────────────────────────────────────────────────────

describe("user track API", () => {
  it("starts with 0 user tracks", () => {
    expect(manager.getUserTrackCount()).toBe(0);
  });

  it("getUserTrackName returns empty string for an out-of-range index", () => {
    expect(manager.getUserTrackName(0)).toBe("");
    expect(manager.getUserTrackName(99)).toBe("");
  });

  it("getUserTrackUrl returns empty string for an out-of-range index", () => {
    expect(manager.getUserTrackUrl(0)).toBe("");
  });
});

// ── _trackDisplayName (private, tested directly) ─────────────────────────────

describe("_trackDisplayName", () => {
  const name = (f: string) => (manager as any)._trackDisplayName(f);

  it("strips the file extension", () => {
    expect(name("my song.mp3")).toBe("MY SONG");
  });

  it("uppercases the result", () => {
    expect(name("lowercase.ogg")).toBe("LOWERCASE");
  });

  it("truncates to 24 characters", () => {
    expect(name("a".repeat(30) + ".mp3").length).toBeLessThanOrEqual(24);
  });

  it("handles a file with no extension", () => {
    expect(name("noext")).toBe("NOEXT");
  });

  it("trims surrounding whitespace", () => {
    expect(name("  padded  .wav")).toBe("PADDED");
  });
});

// ── Upload button ────────────────────────────────────────────────────────────

describe("showUploadButton / hideUploadButton", () => {
  it("showUploadButton injects a #typ0-upload-btn element", () => {
    manager.showUploadButton();
    expect(document.getElementById("typ0-upload-btn")).not.toBeNull();
  });

  it("sets display to block on show", () => {
    manager.showUploadButton();
    const btn = document.getElementById("typ0-upload-btn") as HTMLElement;
    expect(btn.style.display).toBe("block");
  });

  it("sets display to none on hide", () => {
    manager.showUploadButton();
    manager.hideUploadButton();
    const btn = document.getElementById("typ0-upload-btn") as HTMLElement;
    expect(btn.style.display).toBe("none");
  });

  it("calling showUploadButton twice does not create a second button", () => {
    manager.showUploadButton();
    manager.showUploadButton();
    expect(document.querySelectorAll("#typ0-upload-btn").length).toBe(1);
  });

  it("hideUploadButton before show does not throw", () => {
    expect(() => manager.hideUploadButton()).not.toThrow();
  });
});

// ── _onFilesSelected (tested indirectly via the private method) ───────────────

describe("_onFilesSelected", () => {
  it("adds uploaded files as user tracks", () => {
    manager.showUploadButton();
    const input = (manager as any)._fileInput as HTMLInputElement;
    setInputFiles(input, [fakeFile("cool track.mp3"), fakeFile("another.ogg")]);
    (manager as any)._onFilesSelected();

    expect(manager.getUserTrackCount()).toBe(2);
    expect(manager.getUserTrackName(0)).toBe("COOL TRACK");
    expect(manager.getUserTrackName(1)).toBe("ANOTHER");
  });

  it("creates a blob URL for each file", () => {
    manager.showUploadButton();
    const input = (manager as any)._fileInput as HTMLInputElement;
    setInputFiles(input, [fakeFile("song.mp3")]);
    (manager as any)._onFilesSelected();

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(manager.getUserTrackUrl(0)).toMatch(/^blob:/);
  });

  it("replacing a same-named track revokes the old blob URL", () => {
    manager.showUploadButton();
    const input = (manager as any)._fileInput as HTMLInputElement;
    setInputFiles(input, [fakeFile("song.mp3")]);
    (manager as any)._onFilesSelected();
    const oldUrl = manager.getUserTrackUrl(0);

    setInputFiles(input, [fakeFile("song.mp3")]);
    (manager as any)._onFilesSelected();

    expect(URL.revokeObjectURL).toHaveBeenCalledWith(oldUrl);
    expect(manager.getUserTrackCount()).toBe(1);
  });
});
