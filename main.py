"""Pygbag Audio Queue — simple audio input/queuing app.

Routes audio through pygame.mixer on desktop and through the TypeScript
engine in "Audio Engine/" (window.typAudio) when running in the browser via
pygbag. On web, audio_manager.js is injected as an ES module at startup and
the engine's UPLOAD MUSIC overlay button lets the user pick local files.

Controls
  SPACE     play/pause
  LEFT/RIGHT prev/next track
  UP/DOWN   volume +/-
  click a track in the queue to play it
"""
import asyncio
import os
import sys
import pygame

IS_WEB = sys.platform == "emscripten"
if IS_WEB:
    import platform as pf


def _web_audio(method: str, *args):
    """Call window.typAudio.<method>(*args) in the browser.

    Returns the JS return value on success; True when the method returns void
    (JS undefined → Python None). Returns None on any exception so callers can
    distinguish success from failure without crashing the app.
    """
    if not IS_WEB:
        return None
    try:
        result = getattr(pf.window.typAudio, method)(*args)
        return result if result is not None else True
    except Exception as exc:
        print(f"[web audio] {method} failed: {exc}")
        return None

W, H = 800, 600
FPS = 60

BG     = (13, 13, 43)
PANEL  = (20, 20, 60)
DIM    = (90, 90, 130)
WHITE  = (235, 235, 245)
ACCENT = (130, 200, 255)
HI     = (255, 220, 100)


class AudioBackend:
    """Unified play/pause/volume surface over pygame.mixer (desktop) or window.typAudio (web)."""

    def __init__(self) -> None:
        self.volume = 0.7
        self.paused = False
        self.current_url: str | None = None
        self._known_track_count = 0
        if not IS_WEB:
            pygame.mixer.init()
            pygame.mixer.music.set_volume(self.volume)

    def play(self, url: str, loops: int = 0) -> None:
        self.current_url = url
        self.paused = False
        if IS_WEB:
            _web_audio("playMusic", url, loops)
        else:
            try:
                pygame.mixer.music.load(url)
                pygame.mixer.music.play(loops)
            except pygame.error as e:
                print(f"[audio] play failed for {url!r}: {e}")
                self.current_url = None

    def stop(self) -> None:
        self.current_url = None
        self.paused = False
        if IS_WEB:
            _web_audio("stopMusic")
        else:
            pygame.mixer.music.stop()

    def toggle_pause(self) -> None:
        if self.current_url is None:
            return
        if self.paused:
            if IS_WEB:
                _web_audio("unpauseMusic")
            else:
                pygame.mixer.music.unpause()
            self.paused = False
        else:
            if IS_WEB:
                _web_audio("pauseMusic")
            else:
                pygame.mixer.music.pause()
            self.paused = True

    def set_volume(self, v: float) -> None:
        self.volume = max(0.0, min(1.0, v))
        if IS_WEB:
            _web_audio("setVolume", self.volume)
        else:
            pygame.mixer.music.set_volume(self.volume)

    def is_playing(self) -> bool:
        if self.current_url is None or self.paused:
            return False
        if IS_WEB:
            result = _web_audio("isPlaying")
            return bool(result) if result is not None else True
        return pygame.mixer.music.get_busy()

    def show_upload(self) -> None:
        _web_audio("showUploadButton")

    def position_upload(self, vx: int, vy: int, vw: int = W, vh: int = H) -> None:
        _web_audio("setUploadButtonPosition", vx, vy, vw, vh)

    def try_unlock(self) -> None:
        _web_audio("tryUnlock")

    def poll_new_tracks(self) -> list[tuple[str, str]]:
        """Drain any newly uploaded tracks the engine has registered."""
        if not IS_WEB:
            return []
        total_raw = _web_audio("getUserTrackCount")
        if total_raw is None or total_raw is True:
            return []
        total = int(total_raw)
        new: list[tuple[str, str]] = []
        while self._known_track_count < total:
            i = self._known_track_count
            name = _web_audio("getUserTrackName", i)
            url  = _web_audio("getUserTrackUrl", i)
            if isinstance(name, str) and isinstance(url, str):
                new.append((name, url))
            self._known_track_count += 1
        if new:
            _web_audio("clearNewTrackFlag")
        return new


class Queue:
    def __init__(self) -> None:
        self.tracks: list[tuple[str, str]] = []
        self.index = -1

    def add(self, name: str, url: str) -> None:
        self.tracks.append((name, url))
        if self.index < 0:
            self.index = 0

    def current(self) -> tuple[str, str] | None:
        if 0 <= self.index < len(self.tracks):
            return self.tracks[self.index]
        return None

    def step(self, delta: int) -> tuple[str, str] | None:
        if not self.tracks:
            return None
        self.index = (self.index + delta) % len(self.tracks)
        return self.current()

    def select(self, i: int) -> tuple[str, str] | None:
        if 0 <= i < len(self.tracks):
            self.index = i
            return self.current()
        return None


class Button:
    def __init__(self, rect, label, action):
        self.rect = pygame.Rect(rect)
        self.label = label
        self.action = action
        self.hover = False

    def draw(self, surf, font) -> None:
        col = ACCENT if self.hover else WHITE
        pygame.draw.rect(surf, PANEL, self.rect, border_radius=8)
        pygame.draw.rect(surf, col, self.rect, 2, border_radius=8)
        t = font.render(self.label, True, col)
        surf.blit(t, t.get_rect(center=self.rect.center))

    def handle(self, ev) -> None:
        if ev.type == pygame.MOUSEMOTION:
            self.hover = self.rect.collidepoint(ev.pos)
        elif (ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1
              and self.rect.collidepoint(ev.pos)):
            self.action()


def scan_local_assets(path: str = "assets") -> list[tuple[str, str]]:
    """Pick up audio files in ./assets/ for desktop runs (and as a default web playlist)."""
    out: list[tuple[str, str]] = []
    if not os.path.isdir(path):
        return out
    for name in sorted(os.listdir(path)):
        if name.lower().endswith((".ogg", ".mp3", ".wav", ".flac")):
            display = os.path.splitext(name)[0].upper().replace("_", " ")[:24]
            out.append((display, f"{path}/{name}"))
    return out


async def ensure_engine_loaded() -> bool:
    """Inject assets/audio_manager.js as an ES module and wait for window.typAudio."""
    if not IS_WEB:
        return True
    try:
        pf.window.typAudio.getVolume()
        return True
    except Exception:
        pass

    s = pf.document.createElement("script")
    s.type = "module"
    s.src = "assets/audio_manager.js"
    pf.document.head.appendChild(s)

    for _ in range(60):
        await asyncio.sleep(0.05)
        try:
            pf.window.typAudio.getVolume()
            return True
        except Exception:
            continue
    print("[audio] engine failed to load — playback disabled")
    return False


async def main() -> None:
    if IS_WEB:
        # Avoid pygame.init() on web: it would also init pygame.mixer, whose
        # pygbag shim spins forever in an autoplay-retry loop and blocks the
        # rest of the app from ever loading. Web audio goes through typAudio.
        pygame.display.init()
        pygame.font.init()
    else:
        pygame.init()
    screen = pygame.display.set_mode((W, H))
    pygame.display.set_caption("Pygbag Audio Queue")
    clock = pygame.time.Clock()

    title_font = pygame.font.SysFont("monospace", 36, bold=True)
    big_font   = pygame.font.SysFont("monospace", 22, bold=True)
    font       = pygame.font.SysFont("monospace", 17)
    small_font = pygame.font.SysFont("monospace", 13)

    await ensure_engine_loaded()

    audio = AudioBackend()
    queue = Queue()

    for name, url in scan_local_assets("assets"):
        queue.add(name, url)

    def play_current() -> None:
        cur = queue.current()
        if cur:
            audio.play(cur[1], 0)

    def go_next() -> None:
        if queue.step(+1) is not None:
            play_current()

    def go_prev() -> None:
        if queue.step(-1) is not None:
            play_current()

    def toggle_play() -> None:
        if queue.current() is None:
            return
        if audio.current_url is None:
            play_current()
        else:
            audio.toggle_pause()

    def vol_up()   -> None: audio.set_volume(audio.volume + 0.1)
    def vol_down() -> None: audio.set_volume(audio.volume - 0.1)

    btn_y = 445
    buttons = [
        Button((30,  btn_y, 110, 50), "<< PREV",    go_prev),
        Button((150, btn_y, 150, 50), "PLAY/PAUSE", toggle_play),
        Button((310, btn_y, 110, 50), "NEXT >>",    go_next),
        Button((560, btn_y,  70, 50), "VOL-",       vol_down),
        Button((640, btn_y,  70, 50), "VOL+",       vol_up),
    ]

    queue_rect = pygame.Rect(30, 200, W - 60, 160)

    if IS_WEB:
        # Tuck the engine's UPLOAD MUSIC overlay into the empty top-right
        # band next to the Now Playing card, well clear of every pygame widget.
        audio.position_upload(665, 125, W, H)
        audio.show_upload()

    last_playing = False
    running = True

    while running:
        for ev in pygame.event.get():
            if ev.type == pygame.QUIT:
                running = False
            elif ev.type == pygame.KEYDOWN:
                audio.try_unlock()
                if ev.key == pygame.K_SPACE:
                    toggle_play()
                elif ev.key in (pygame.K_RIGHT, pygame.K_n):
                    go_next()
                elif ev.key in (pygame.K_LEFT, pygame.K_p):
                    go_prev()
                elif ev.key in (pygame.K_UP, pygame.K_EQUALS, pygame.K_PLUS):
                    vol_up()
                elif ev.key in (pygame.K_DOWN, pygame.K_MINUS):
                    vol_down()
            elif ev.type == pygame.MOUSEBUTTONDOWN and ev.button == 1:
                audio.try_unlock()
                if queue_rect.collidepoint(ev.pos):
                    row = (ev.pos[1] - (queue_rect.y + 12)) // 24
                    if 0 <= row < len(queue.tracks):
                        queue.select(row)
                        play_current()
            for b in buttons:
                b.handle(ev)

        for name, url in audio.poll_new_tracks():
            queue.add(name, url)
            if audio.current_url is None:
                queue.index = len(queue.tracks) - 1
                play_current()

        now_playing = audio.is_playing()
        if last_playing and not now_playing and not audio.paused and queue.tracks:
            go_next()
        last_playing = now_playing

        screen.fill(BG)

        title = title_font.render("AUDIO QUEUE", True, ACCENT)
        screen.blit(title, title.get_rect(center=(W // 2, 38)))

        bx, by, bw = W - 200, 70, 160
        screen.blit(small_font.render(f"VOLUME {int(audio.volume * 100):>3}%", True, DIM), (bx, by - 16))
        pygame.draw.rect(screen, DIM, (bx, by, bw, 8), 1)
        pygame.draw.rect(screen, ACCENT, (bx, by, int(bw * audio.volume), 8))

        np_rect = pygame.Rect(30, 80, 510, 90)
        pygame.draw.rect(screen, PANEL, np_rect, border_radius=10)
        pygame.draw.rect(screen, DIM, np_rect, 2, border_radius=10)
        cur = queue.current()
        if audio.is_playing():
            status, scol = "NOW PLAYING", HI
        elif audio.paused:
            status, scol = "PAUSED", DIM
        elif cur:
            status, scol = "QUEUED", DIM
        else:
            status, scol = "EMPTY", DIM
        screen.blit(small_font.render(status, True, scol), (np_rect.x + 16, np_rect.y + 12))
        name = cur[0] if cur else "Upload a track to begin..."
        screen.blit(big_font.render(name, True, WHITE), (np_rect.x + 16, np_rect.y + 38))

        pygame.draw.rect(screen, PANEL, queue_rect, border_radius=10)
        pygame.draw.rect(screen, DIM, queue_rect, 2, border_radius=10)
        plural = "s" if len(queue.tracks) != 1 else ""
        header = f"QUEUE  ({len(queue.tracks)} track{plural})"
        screen.blit(small_font.render(header, True, DIM), (queue_rect.x + 16, queue_rect.y - 18))
        if not queue.tracks:
            empty_msg = ("Empty — click UPLOAD MUSIC below to add files." if IS_WEB
                         else "Empty — drop audio files into ./assets/ and relaunch.")
            screen.blit(font.render(empty_msg, True, DIM), (queue_rect.x + 18, queue_rect.y + 18))
        else:
            for i, (track_name, _url) in enumerate(queue.tracks):
                y = queue_rect.y + 12 + i * 24
                if y + 22 > queue_rect.bottom:
                    break
                is_cur = (i == queue.index)
                if is_cur and audio.is_playing():
                    col = HI
                elif is_cur:
                    col = ACCENT
                else:
                    col = WHITE
                marker = "> " if is_cur else "  "
                line = font.render(f"{marker}{i + 1:>2}. {track_name}", True, col)
                screen.blit(line, (queue_rect.x + 16, y))

        for b in buttons:
            b.draw(screen, font)

        hint = "SPACE play/pause   <- ->  prev/next   UP/DOWN  volume   click a queue row to play"
        screen.blit(small_font.render(hint, True, DIM),
                    small_font.render(hint, True, DIM).get_rect(center=(W // 2, 560)))

        pygame.display.flip()
        await asyncio.sleep(0)
        clock.tick(FPS)

    pygame.quit()


if __name__ == "__main__":
    asyncio.run(main())
