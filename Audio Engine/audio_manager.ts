/**
 * Typ0 Web Audio Manager
 *
 * Replaces pygame.mixer for browser (pygbag/WASM) builds.
 * Exposed as window.typAudio and called from Python via the pygbag JS bridge:
 *
 *   import platform
 *   platform.window.typAudio.playMusic("assets/Typ0__Main_Theme.ogg", -1)
 *
 * Audio files must be served as static HTTP files alongside index.html.
 * The build process copies assets/*.ogg → build/web/assets/*.ogg.
 */

interface UserTrack {
  name: string;
  url: string;
}

export class AudioManager {
  private musicEl: HTMLAudioElement | null = null;
  private _volume: number = 0.7;
  private _paused: boolean = false;

  // ── Autoplay unlock ───────────────────────────────────────────────────────
  private _unlocked: boolean = false;
  private _pendingFile: string | null = null;
  private _pendingLoops: number = -1;

  // ── User-uploaded tracks ──────────────────────────────────────────────────
  private _userTracks: UserTrack[] = [];
  private _uploadBtn: HTMLButtonElement | null = null;
  private _fileInput: HTMLInputElement | null = null;
  private _resizeHandler: (() => void) | null = null;

  // ── New-track notification (polled by Python) ─────────────────────────────
  private _newTrackAdded: boolean = false;
  private _lastAddedIndex: number = -1;

  constructor() {
    // On the first user gesture, unlock audio and replay anything that was
    // blocked by the browser's autoplay policy.
    const unlock = () => {
      if (this._unlocked) return;
      this._unlocked = true;
      if (this._pendingFile !== null) {
        const file = this._pendingFile;
        const loops = this._pendingLoops;
        this._pendingFile = null;
        this._playNow(file, loops);
      }
    };
    ["click", "keydown", "touchstart", "pointerdown"].forEach((evt) => {
      window.addEventListener(evt, unlock, { once: false, passive: true });
    });
  }

  /**
   * Explicitly unlock audio — called from Python on the first pygame event
   * so audio starts as soon as the user interacts with the game canvas,
   * without requiring a separate DOM click.
   */
  tryUnlock(): void {
    if (this._unlocked) return;
    this._unlocked = true;
    if (this._pendingFile !== null) {
      const file = this._pendingFile;
      const loops = this._pendingLoops;
      this._pendingFile = null;
      this._playNow(file, loops);
    }
  }

  /**
   * Load and play background music.
   * loops: -1 = infinite loop, 0 = play once, n > 0 = loop n+1 times (pygame semantics)
   */
  playMusic(file: string, loops: number = -1): void {
    if (!this._unlocked) {
      // Autoplay not yet allowed — remember intent and play on first gesture
      this.stopMusic(true);
      this._pendingFile = file;
      this._pendingLoops = loops;
      return;
    }
    this._playNow(file, loops);
  }

  private _playNow(file: string, loops: number): void {
    this.stopMusic();

    const audio = new Audio(this._toUrl(file));
    audio.volume = this._volume;

    if (loops === -1) {
      audio.loop = true;
    } else if (loops === 0) {
      audio.loop = false;
    } else {
      // Play loops+1 times total (pygame: play(1) means play twice)
      audio.loop = false;
      let count = 0;
      const onEnded = () => {
        count++;
        if (count <= loops && this.musicEl === audio) {
          audio.currentTime = 0;
          audio.play().catch(() => {});
        } else {
          audio.removeEventListener("ended", onEnded);
        }
      };
      audio.addEventListener("ended", onEnded);
    }

    this.musicEl = audio;
    this._paused = false;
    audio.play().catch((e) => {
      console.warn("[typAudio] playMusic failed:", e);
      // If play was blocked despite the unlock flag, queue it for retry
      this._unlocked = false;
      this._pendingFile = file;
      this._pendingLoops = loops;
      this.musicEl = null;
    });
  }

  stopMusic(clearPending: boolean = true): void {
    if (this.musicEl) {
      this.musicEl.pause();
      this.musicEl.loop = false;
      this.musicEl.currentTime = 0;
      this.musicEl.removeAttribute("src");
      this.musicEl.load();
      this.musicEl = null;
    }
    if (clearPending) {
      // Clear any queued file so it doesn't fire unexpectedly after an unlock.
      this._pendingFile = null;
    }
    this._paused = false;
  }

  pauseMusic(): void {
    if (this.musicEl && !this._paused) {
      this.musicEl.pause();
      this._paused = true;
    }
  }

  unpauseMusic(): void {
    if (this.musicEl && this._paused) {
      this.musicEl
        .play()
        .catch((e) => console.warn("[typAudio] unpauseMusic failed:", e));
      this._paused = false;
    }
  }

  /** volume: 0.0-1.0 */
  setVolume(v: number): void {
    this._volume = Math.max(0, Math.min(1, Number(v)));
    if (this.musicEl) {
      this.musicEl.volume = this._volume;
    }
  }

  getVolume(): number {
    return this._volume;
  }

  /** Play a one-shot sound effect (fire and forget). */
  playSound(file: string): void {
    if (!this._unlocked) return; // drop SFX before first gesture — not worth queuing
    const audio = new Audio(this._toUrl(file));
    audio.volume = this._volume;
    audio.play().catch((e) => console.warn("[typAudio] playSound failed:", e));
  }

  // ── User-upload API (called from Python via JS bridge) ────────────────────

  /** Show the HTML upload button overlay above the canvas. */
  showUploadButton(): void {
    if (!this._uploadBtn) this._initUploadElements();
    if (this._uploadBtn) {
      this._uploadBtn.style.display = "block";
      this._positionOverMenu();
      if (!this._resizeHandler) {
        this._resizeHandler = () => this._positionOverMenu();
        window.addEventListener("resize", this._resizeHandler);
      }
    }
  }

  /** Hide the HTML upload button overlay. */
  hideUploadButton(): void {
    if (this._uploadBtn) this._uploadBtn.style.display = "none";
    if (this._resizeHandler) {
      window.removeEventListener("resize", this._resizeHandler);
      this._resizeHandler = null;
    }
  }

  /**
   * Place the upload button on top of the pygame menu's brick popup.
   * The pygame canvas is letterboxed inside a 100%×100% element, so we
   * re-derive the letterbox offsets from the canvas rect and map virtual
   * coordinates (800×600 game space) to viewport pixels.
   */
  private _positionOverMenu(): void {
    if (!this._uploadBtn) return;
    const canvas = document.querySelector("canvas.emscripten") as HTMLCanvasElement | null;
    if (!canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const VW = 800, VH = 600;
    const scale = Math.min(r.width / VW, r.height / VH);
    const offX = r.left + (r.width - VW * scale) / 2;
    const offY = r.top + (r.height - VH * scale) / 2;
    // Menu brick popup is 500×400 virtual, centered at (400, 300).
    // Sit just above the BACK button (which runs y≈425–480 virtual).
    const vx = 400, vy = 395;
    const btn = this._uploadBtn;
    btn.style.right = "auto";
    btn.style.transform = "none";
    btn.style.left = (offX + vx * scale - btn.offsetWidth / 2) + "px";
    btn.style.top  = (offY + vy * scale - btn.offsetHeight / 2) + "px";
  }

  /** Number of tracks the user has uploaded this session. */
  getUserTrackCount(): number {
    return this._userTracks.length;
  }

  /** Display name of user track at index (e.g. "MY SONG"). */
  getUserTrackName(index: number): string {
    return this._userTracks[index]?.name ?? "";
  }

  /** Blob URL of user track at index — pass directly to playMusic(). */
  getUserTrackUrl(index: number): string {
    return this._userTracks[index]?.url ?? "";
  }

  /** True if a new track was added since the last clearNewTrackFlag() call. */
  hasNewTrack(): boolean {
    return this._newTrackAdded;
  }

  /** Index of the most recently added user track (within _userTracks). */
  getLastAddedTrackIndex(): number {
    return this._lastAddedIndex;
  }

  /** Reset the new-track flag — call from Python after auto-selecting the track. */
  clearNewTrackFlag(): void {
    this._newTrackAdded = false;
  }

  /** True if music is currently playing (not stopped or paused). */
  isPlaying(): boolean {
    return this.musicEl !== null && !this._paused && !this.musicEl.paused && !this.musicEl.ended;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /**
   * Create the hidden file input and the visible upload button.
   * Called lazily on first showUploadButton() so the DOM is guaranteed ready.
   */
  private _initUploadElements(): void {
    // Hidden file input — reused across selections
    this._fileInput = document.createElement("input");
    this._fileInput.type = "file";
    this._fileInput.accept = "audio/*";
    this._fileInput.multiple = true;
    this._fileInput.style.display = "none";
    this._fileInput.addEventListener("change", () => this._onFilesSelected());
    document.body.appendChild(this._fileInput);

    // Visible upload button — styled to match the game's aesthetic
    this._uploadBtn = document.createElement("button");
    this._uploadBtn.id = "typ0-upload-btn";
    this._uploadBtn.textContent = "\u2B06 UPLOAD MUSIC";
    Object.assign(this._uploadBtn.style, {
      display: "none",
      position: "fixed",
      top: "16px",
      right: "16px",
      padding: "10px 22px",
      background: "#0d0d2b",
      color: "#ffffff",
      border: "2px solid #aaaaaa",
      borderRadius: "10px",
      fontFamily: "monospace, sans-serif",
      fontSize: "14px",
      fontWeight: "bold",
      letterSpacing: "2px",
      cursor: "pointer",
      zIndex: "9999",
      userSelect: "none",
      textAlign: "center",
      boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
    } as Partial<CSSStyleDeclaration>);

    this._uploadBtn.addEventListener("mouseenter", () => {
      if (this._uploadBtn) this._uploadBtn.style.background = "#1a1a5e";
    });
    this._uploadBtn.addEventListener("mouseleave", () => {
      if (this._uploadBtn) this._uploadBtn.style.background = "#0d0d2b";
    });

    // Direct user click on the button triggers the file picker — this is a
    // trusted gesture so the browser always allows it.
    this._uploadBtn.addEventListener("click", () => {
      this._fileInput?.click();
    });

    document.body.appendChild(this._uploadBtn);
  }

  /** Handle files chosen by the user. */
  private _onFilesSelected(): void {
    const input = this._fileInput;
    if (!input?.files?.length) return;

    const MAX_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
    const ALLOWED_TYPES = /^audio\//;
    const ALLOWED_EXTS  = /\.(mp3|ogg|wav|flac|aac|m4a|opus|webm)$/i;

    for (const file of Array.from(input.files)) {
      // File-type check: MIME type OR extension (MIME can be empty on some OS)
      const mimeOk = ALLOWED_TYPES.test(file.type);
      const extOk  = ALLOWED_EXTS.test(file.name);
      if (!mimeOk && !extOk) {
        console.warn(`[typAudio] Rejected non-audio file: ${file.name} (type: ${file.type || "unknown"})`);
        continue;
      }

      // File-size check
      if (file.size > MAX_SIZE_BYTES) {
        const mb = (file.size / (1024 * 1024)).toFixed(1);
        console.warn(`[typAudio] Rejected oversized file: ${file.name} (${mb} MB — limit 50 MB)`);
        continue;
      }

      const name = this._trackDisplayName(file.name);

      // Replace any existing track with the same display name
      const existing = this._userTracks.findIndex((t) => t.name === name);
      if (existing >= 0) {
        URL.revokeObjectURL(this._userTracks[existing].url);
        this._userTracks.splice(existing, 1);
      }

      this._userTracks.push({ name, url: URL.createObjectURL(file) });
      this._lastAddedIndex = this._userTracks.length - 1;
      this._newTrackAdded  = true;
      console.log(`[typAudio] User track added: ${name}`);
    }

    // Reset so the same file(s) can be re-selected if needed
    input.value = "";
  }

  /**
   * Convert a filename to a short uppercase display name.
   * "my cool song.mp3" → "MY COOL SONG"  (capped at 24 chars)
   */
  private _trackDisplayName(filename: string): string {
    return filename
      .replace(/\.[^.]+$/, "")
      .toUpperCase()
      .slice(0, 24)
      .trim();
  }

  /**
   * Normalize Python asset paths to web-relative URLs.
   * "assets\\Techno.ogg" → "assets/Techno.ogg"
   * Blob URLs are returned unchanged.
   */
  private _toUrl(file: string): string {
    return file.replace(/\\/g, "/");
  }
}

// Expose globally — Python calls window.typAudio.* via pygbag's JS bridge
(window as any).typAudio = new AudioManager();
console.log("[typAudio] Audio manager ready");
