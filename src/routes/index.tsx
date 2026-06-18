import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AirInk — Real-time Air Writing & Hand Gesture Detection" },
      {
        name: "description",
        content:
          "Write in the air with your fingertip. Real-time hand tracking, gesture controls, whiteboard mode, snapshots, and AI handwriting recognition with speech output.",
      },
      { property: "og:title", content: "AirInk — Real-time Air Writing" },
      {
        property: "og:description",
        content:
          "Real-time air writing with gesture controls, whiteboard mode and AI handwriting recognition.",
      },
    ],
  }),
  component: Index,
});

type Pt = { x: number; y: number };
type Stroke = { points: Pt[]; color: string; size: number };

declare global {
  interface Window {
    Hands: any;
    Camera: any;
  }
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement("script");
    s.src = src;
    s.crossOrigin = "anonymous";
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

type Gesture = "draw" | "hover" | "erase" | "clear" | "pinch" | "none";

const COLORS = ["#fff200", "#ff3b8b", "#22ff66", "#22d3ee", "#ffffff", "#000000"];

// ---------- Smoothing: simplified One-Euro filter ----------
class OneEuro {
  private xPrev: number | null = null;
  private dxPrev = 0;
  private tPrev = 0;
  constructor(private minCutoff = 1.2, private beta = 0.015, private dCutoff = 1.0) {}
  private alpha(cutoff: number, dt: number) {
    const r = 2 * Math.PI * cutoff * dt;
    return r / (r + 1);
  }
  filter(x: number, t: number) {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = t;
      return x;
    }
    const dt = Math.max(0.001, (t - this.tPrev) / 1000);
    this.tPrev = t;
    const dx = (x - this.xPrev) / dt;
    const ad = this.alpha(this.dCutoff, dt);
    const dxHat = ad * dx + (1 - ad) * this.dxPrev;
    this.dxPrev = dxHat;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * x + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }
  reset() {
    this.xPrev = null;
    this.dxPrev = 0;
  }
}

function Index() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const inkRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);

  // smoothing & gesture state
  const fxRef = useRef(new OneEuro());
  const fyRef = useRef(new OneEuro());
  const lastTipRef = useRef<Pt | null>(null);
  const lastSeenRef = useRef<number>(0);
  const gestureBufRef = useRef<Gesture[]>([]);
  const stableGestureRef = useRef<Gesture>("none");
  const clearHeldRef = useRef<number>(0);
  const pinchHeldRef = useRef<number>(0);

  // refs mirroring state for use inside MediaPipe callback
  const colorRef = useRef<string>(COLORS[0]);
  const sizeRef = useRef<number>(10);
  const whiteboardRef = useRef<boolean>(false);

  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(10);
  const [whiteboard, setWhiteboard] = useState(false);
  const [gesture, setGesture] = useState<Gesture>("none");
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading hand tracking…");
  const [elapsed, setElapsed] = useState(0);
  const [recognizing, setRecognizing] = useState(false);
  const [recognized, setRecognized] = useState<string>("");
  const [fps, setFps] = useState(0);
  const [snapshots, setSnapshots] = useState<string[]>([]);

  useEffect(() => { colorRef.current = color; }, [color]);
  useEffect(() => { sizeRef.current = size; }, [size]);
  useEffect(() => { whiteboardRef.current = whiteboard; }, [whiteboard]);

  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [ready]);

  const renderInk = useCallback(() => {
    const c = inkRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.clearRect(0, 0, c.width, c.height);
    const all = currentRef.current
      ? [...strokesRef.current, currentRef.current]
      : strokesRef.current;
    for (const s of all) {
      if (s.points.length < 1) continue;
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = whiteboardRef.current ? "transparent" : "rgba(0,0,0,0.45)";
      ctx.shadowBlur = whiteboardRef.current ? 0 : 3;
      ctx.beginPath();
      // Smooth path with quadratic curves through midpoints
      if (s.points.length === 1) {
        ctx.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
      } else if (s.points.length === 2) {
        ctx.moveTo(s.points[0].x, s.points[0].y);
        ctx.lineTo(s.points[1].x, s.points[1].y);
        ctx.stroke();
      } else {
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length - 1; i++) {
          const midX = (s.points[i].x + s.points[i + 1].x) / 2;
          const midY = (s.points[i].y + s.points[i + 1].y) / 2;
          ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, midX, midY);
        }
        const last = s.points[s.points.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
  }, []);

  // re-render ink whenever whiteboard toggles
  useEffect(() => { renderInk(); }, [whiteboard, renderInk]);

  useEffect(() => {
    let cancelled = false;
    let camera: any;
    let hands: any;
    let frames = 0;
    let fpsTimer: any;

    (async () => {
      try {
        await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
        await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
        if (cancelled) return;

        const video = videoRef.current!;
        const overlay = overlayRef.current!;
        const ink = inkRef.current!;
        const octx = overlay.getContext("2d")!;

        hands = new window.Hands({
          locateFile: (file: string) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.55,
          minTrackingConfidence: 0.55,
        });

        fpsTimer = setInterval(() => { setFps(frames); frames = 0; }, 1000);

        const STROKE_GRACE_MS = 250; // keep stroke alive briefly when hand briefly lost
        const GESTURE_WINDOW = 5;    // frames of agreement to switch gesture

        hands.onResults((results: any) => {
          frames++;
          const now = performance.now();
          const w = overlay.width;
          const h = overlay.height;
          octx.clearRect(0, 0, w, h);

          let rawG: Gesture = "none";
          let tip: Pt | null = null;

          if (results.multiHandLandmarks && results.multiHandLandmarks[0]) {
            lastSeenRef.current = now;
            const lm = results.multiHandLandmarks[0];
            const mx = (p: any) => ({ x: (1 - p.x) * w, y: p.y * h });

            const wrist = mx(lm[0]);
            const indexTip = mx(lm[8]);
            const indexPip = mx(lm[6]);
            const middleTip = mx(lm[12]);
            const middlePip = mx(lm[10]);
            const ringTip = mx(lm[16]);
            const ringPip = mx(lm[14]);
            const pinkyTip = mx(lm[20]);
            const pinkyPip = mx(lm[18]);
            const thumbTip = mx(lm[4]);

            const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
            const ext = (tipP: Pt, pip: Pt) => dist(tipP, wrist) > dist(pip, wrist) * 1.03;

            const iExt = ext(indexTip, indexPip);
            const mExt = ext(middleTip, middlePip);
            const rExt = ext(ringTip, ringPip);
            const pExt = ext(pinkyTip, pinkyPip);
            const extendedCount = [iExt, mExt, rExt, pExt].filter(Boolean).length;

            // Pinch: index-thumb close (relative to hand size)
            const handSize = dist(wrist, indexPip) || 1;
            const pinch = dist(indexTip, thumbTip) < handSize * 0.35;

            if (pinch) rawG = "pinch";
            else if (iExt && !mExt && !rExt && !pExt) rawG = "draw";
            else if (iExt && mExt && !rExt && !pExt) rawG = "hover";
            else if (iExt && mExt && rExt && pExt) rawG = "clear";
            else if (extendedCount === 0) rawG = "erase";
            else rawG = "hover";

            // Smooth tip via one-euro filter
            const sx = fxRef.current.filter(indexTip.x, now);
            const sy = fyRef.current.filter(indexTip.y, now);
            tip = { x: sx, y: sy };
            lastTipRef.current = tip;
          } else {
            // hand lost — keep last tip during grace period
            if (now - lastSeenRef.current < STROKE_GRACE_MS && lastTipRef.current) {
              tip = lastTipRef.current;
              rawG = stableGestureRef.current; // keep going briefly
            } else {
              rawG = "none";
              fxRef.current.reset();
              fyRef.current.reset();
              lastTipRef.current = null;
            }
          }

          // Gesture hysteresis: only switch if last N frames agree
          gestureBufRef.current.push(rawG);
          if (gestureBufRef.current.length > GESTURE_WINDOW) gestureBufRef.current.shift();
          let stable = stableGestureRef.current;
          if (gestureBufRef.current.length === GESTURE_WINDOW) {
            const all = gestureBufRef.current.every((g) => g === rawG);
            // allow instant switch into "draw" when current is hover/none for responsiveness
            const quickInto = rawG === "draw" && (stable === "hover" || stable === "none");
            if (all || quickInto) stable = rawG;
          }
          stableGestureRef.current = stable;

          // Stroke logic
          if (stable === "draw" && tip) {
            if (!currentRef.current) {
              currentRef.current = { points: [], color: colorRef.current, size: sizeRef.current };
            }
            const pts = currentRef.current.points;
            const last = pts[pts.length - 1];
            if (!last) {
              pts.push(tip);
            } else {
              const d = Math.hypot(last.x - tip.x, last.y - tip.y);
              // skip implausible jumps (tracking glitches) — don't break the stroke either
              if (d < Math.min(w, h) * 0.4 && d > 0.8) pts.push(tip);
            }
          } else {
            if (currentRef.current && currentRef.current.points.length > 0) {
              strokesRef.current.push(currentRef.current);
              redoRef.current = [];
            }
            currentRef.current = null;
          }

          if (stable === "erase" && tip) {
            const r = 35;
            strokesRef.current = strokesRef.current.filter(
              (s) => !s.points.some((p) => Math.hypot(p.x - tip!.x, p.y - tip!.y) < r),
            );
          }

          // Hold-to-clear (open palm ~0.8s)
          if (stable === "clear") {
            clearHeldRef.current += 1;
            if (clearHeldRef.current > 24) {
              strokesRef.current = [];
              currentRef.current = null;
              redoRef.current = [];
              clearHeldRef.current = 0;
            }
          } else clearHeldRef.current = 0;

          // Pinch (hold ~0.4s) → snapshot
          if (stable === "pinch") {
            pinchHeldRef.current += 1;
          } else {
            if (pinchHeldRef.current >= 12 && pinchHeldRef.current < 60) {
              // take snapshot
              try {
                const ink = inkRef.current!;
                const out = document.createElement("canvas");
                out.width = ink.width; out.height = ink.height;
                const ctx = out.getContext("2d")!;
                if (!whiteboardRef.current) {
                  ctx.save(); ctx.translate(out.width, 0); ctx.scale(-1, 1);
                  ctx.drawImage(video, 0, 0, out.width, out.height);
                  ctx.restore();
                } else {
                  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, out.width, out.height);
                }
                ctx.drawImage(ink, 0, 0);
                setSnapshots((s) => [out.toDataURL("image/png"), ...s].slice(0, 8));
              } catch {}
            }
            pinchHeldRef.current = 0;
          }

          if (stable !== gesture) setGesture(stable);

          // ---- HUD cursors ----
          const drawCircle = (p: Pt, r: number, fill: string, stroke?: string) => {
            octx.beginPath(); octx.arc(p.x, p.y, r, 0, Math.PI * 2);
            octx.fillStyle = fill; octx.fill();
            if (stroke) { octx.strokeStyle = stroke; octx.lineWidth = 2; octx.stroke(); }
          };

          if (tip) {
            if (stable === "draw") {
              drawCircle(tip, Math.max(6, sizeRef.current * 0.9), colorRef.current, "#000");
            } else if (stable === "hover") {
              drawCircle(tip, 10, "rgba(255,255,255,0.2)", "#fff");
            } else if (stable === "erase") {
              drawCircle(tip, 35, "rgba(255,80,80,0.18)", "#ff4444");
            } else if (stable === "clear") {
              drawCircle(tip, 18, "rgba(34,255,102,0.25)", "#22ff66");
              octx.strokeStyle = "#22ff66"; octx.lineWidth = 4;
              octx.beginPath();
              octx.arc(tip.x, tip.y, 26, -Math.PI / 2,
                -Math.PI / 2 + (clearHeldRef.current / 24) * Math.PI * 2);
              octx.stroke();
            } else if (stable === "pinch") {
              drawCircle(tip, 14, "rgba(34,211,238,0.25)", "#22d3ee");
            }
          }

          renderInk();
        });

        camera = new window.Camera(video, {
          onFrame: async () => { await hands.send({ image: video }); },
          width: 1280,
          height: 720,
        });

        setStatus("Starting camera…");
        await camera.start();

        const sync = () => {
          if (!video.videoWidth) return;
          overlay.width = video.videoWidth;
          overlay.height = video.videoHeight;
          ink.width = video.videoWidth;
          ink.height = video.videoHeight;
        };
        if (video.readyState >= 2) sync();
        else video.addEventListener("loadedmetadata", sync, { once: true });

        setReady(true);
        setStatus("Ready. Point one finger to draw.");
      } catch (e: any) {
        setStatus(e?.message ?? "Failed to start. Allow camera access.");
      }
    })();

    return () => {
      cancelled = true;
      clearInterval(fpsTimer);
      try { camera?.stop?.(); } catch {}
      try { hands?.close?.(); } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderInk]);

  const clearAll = () => {
    strokesRef.current = []; currentRef.current = null; redoRef.current = [];
    renderInk(); setRecognized("");
  };
  const undo = () => {
    const s = strokesRef.current.pop(); if (s) redoRef.current.push(s); renderInk();
  };
  const redo = () => {
    const s = redoRef.current.pop(); if (s) strokesRef.current.push(s); renderInk();
  };
  const endStroke = () => {
    if (currentRef.current && currentRef.current.points.length > 0) {
      strokesRef.current.push(currentRef.current);
    }
    currentRef.current = null;
  };

  const savePng = () => {
    const video = videoRef.current!;
    const ink = inkRef.current!;
    const out = document.createElement("canvas");
    out.width = ink.width; out.height = ink.height;
    const ctx = out.getContext("2d")!;
    if (whiteboard) {
      ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, out.width, out.height);
    } else {
      ctx.save(); ctx.translate(out.width, 0); ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, out.width, out.height);
      ctx.restore();
    }
    ctx.drawImage(ink, 0, 0);
    const a = document.createElement("a");
    a.download = `airink-${Date.now()}.png`;
    a.href = out.toDataURL("image/png"); a.click();
  };

  const recognize = async () => {
    const ink = inkRef.current!;
    if (!ink || strokesRef.current.length === 0) return;
    const out = document.createElement("canvas");
    out.width = ink.width; out.height = ink.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, out.width, out.height);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.strokeStyle = "#000"; ctx.fillStyle = "#000";
    for (const s of strokesRef.current) {
      if (s.points.length < 1) continue;
      ctx.lineWidth = Math.max(s.size, 8);
      if (s.points.length === 1) {
        ctx.beginPath();
        ctx.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, Math.PI * 2); ctx.fill();
      } else {
        ctx.beginPath(); ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length - 1; i++) {
          const mx = (s.points[i].x + s.points[i + 1].x) / 2;
          const my = (s.points[i].y + s.points[i + 1].y) / 2;
          ctx.quadraticCurveTo(s.points[i].x, s.points[i].y, mx, my);
        }
        const last = s.points[s.points.length - 1];
        ctx.lineTo(last.x, last.y); ctx.stroke();
      }
    }
    try {
      setRecognizing(true); setRecognized("");
      const res = await fetch("/api/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: out.toDataURL("image/png") }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRecognized(data.text || "(nothing recognized)");
    } catch (e: any) {
      setRecognized(`Error: ${e.message}`);
    } finally { setRecognizing(false); }
  };

  const speak = () => {
    if (!recognized) return;
    const u = new SpeechSynthesisUtterance(recognized);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  };

  const copyText = async () => {
    if (!recognized) return;
    try { await navigator.clipboard.writeText(recognized); } catch {}
  };

  const toggleFullscreen = () => {
    const el = wrapRef.current;
    if (!el) return;
    if (!document.fullscreenElement) el.requestFullscreen?.();
    else document.exitFullscreen?.();
  };

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const gestureLabel: Record<Gesture, { text: string; cls: string }> = {
    draw: { text: "DRAWING", cls: "bg-yellow-400 text-black" },
    hover: { text: "HOVER", cls: "bg-white/20 text-white" },
    erase: { text: "ERASING", cls: "bg-red-500 text-white" },
    clear: { text: "HOLD TO CLEAR", cls: "bg-emerald-500 text-black" },
    pinch: { text: "PINCH → SNAPSHOT", cls: "bg-cyan-400 text-black" },
    none: { text: "NO HAND", cls: "bg-zinc-700 text-zinc-300" },
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center gap-4 p-4">
      <header className="w-full max-w-6xl flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AirInk</h1>
          <p className="text-sm text-muted-foreground">
            Smooth air writing with gestures, whiteboard mode & AI recognition
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={endStroke} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">End stroke</button>
          <button onClick={undo} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Undo</button>
          <button onClick={redo} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Redo</button>
          <button onClick={clearAll} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Clear</button>
          <button onClick={savePng} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Save PNG</button>
          <button onClick={toggleFullscreen} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Fullscreen</button>
          <button
            onClick={recognize}
            disabled={recognizing}
            className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:opacity-90 disabled:opacity-50"
          >
            {recognizing ? "Reading…" : "Recognize"}
          </button>
        </div>
      </header>

      {/* Toolbar */}
      <div className="w-full max-w-6xl flex flex-wrap items-center gap-4 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">Color</span>
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className={`w-7 h-7 rounded-full border-2 ${color === c ? "ring-2 ring-primary border-white" : "border-white/30"}`}
              style={{ background: c }}
              aria-label={`color ${c}`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">Brush</span>
          <input type="range" min={2} max={36} value={size} onChange={(e) => setSize(Number(e.target.value))} className="w-32" />
          <span className="text-xs tabular-nums w-6">{size}</span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={whiteboard} onChange={(e) => setWhiteboard(e.target.checked)} />
          Whiteboard mode
        </label>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{fps} fps</span>
          <span>·</span>
          <span className="font-mono">{mm}:{ss}</span>
        </div>
      </div>

      <div
        ref={wrapRef}
        className="relative w-full max-w-6xl aspect-video bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10"
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover -scale-x-100 transition-opacity ${whiteboard ? "opacity-0" : "opacity-100"}`}
        />
        {whiteboard && <div className="absolute inset-0 bg-white" />}
        <canvas ref={inkRef} className="absolute inset-0 w-full h-full pointer-events-none" />
        <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />

        <div className="absolute top-4 left-4 flex items-center gap-2">
          <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wider shadow ${gestureLabel[gesture].cls}`}>
            {gestureLabel[gesture].text}
          </span>
        </div>

        <div className="absolute top-4 right-4 rounded-md bg-black/60 text-white px-3 py-1.5 text-lg font-mono tracking-wider">
          {mm}:{ss}
        </div>

        <div className={`absolute bottom-4 left-4 max-w-xs rounded-lg text-xs p-3 space-y-1 backdrop-blur ${whiteboard ? "bg-black/10 text-zinc-700" : "bg-black/60 text-white"}`}>
          <div className="font-bold mb-1 text-[10px] uppercase tracking-wider opacity-70">Gestures</div>
          <div>☝️ Index only → <b>Draw</b></div>
          <div>✌️ Index + middle → Hover (lift pen)</div>
          <div>🤏 Pinch (quick) → Snapshot</div>
          <div>✊ Fist → Erase near tip</div>
          <div>🖐️ Open palm (hold) → Clear all</div>
        </div>

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-white text-sm">
            {status}
          </div>
        )}
      </div>

      {recognized && (
        <div className="w-full max-w-6xl rounded-lg border bg-card p-4 flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">AI recognized</div>
              <div className="text-2xl font-semibold break-words">{recognized}</div>
            </div>
            <div className="flex gap-2">
              <button onClick={speak} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">🔊 Speak</button>
              <button onClick={copyText} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">Copy</button>
            </div>
          </div>
        </div>
      )}

      {snapshots.length > 0 && (
        <div className="w-full max-w-6xl rounded-lg border bg-card p-3">
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-2">Snapshots</div>
          <div className="flex gap-2 overflow-x-auto">
            {snapshots.map((src, i) => (
              <a key={i} href={src} download={`airink-snap-${i}.png`} className="shrink-0">
                <img src={src} alt={`snapshot ${i}`} className="h-24 rounded border" />
              </a>
            ))}
          </div>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-2xl">
        Real-life uses: classroom teaching on whiteboard mode, sign-language demos, contactless kiosks, accessibility input, quick notes saved as PNG, and AI text dictation via Recognize → Speak.
      </p>
    </div>
  );
}
