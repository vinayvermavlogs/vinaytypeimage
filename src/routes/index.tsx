import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState, useCallback } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AirInk — Real-time Air Writing & Hand Gesture Detection" },
      {
        name: "description",
        content:
          "Write in the air with your fingertip. Real-time hand tracking, gesture controls, color & brush selection, undo, save, and AI handwriting recognition.",
      },
      { property: "og:title", content: "AirInk — Real-time Air Writing" },
      {
        property: "og:description",
        content:
          "Write in the air with your fingertip. Real-time hand tracking with gesture controls and AI handwriting recognition.",
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

type Gesture = "draw" | "hover" | "erase" | "clear" | "none";

const COLORS = ["#fff200", "#ff3b8b", "#22ff66", "#22d3ee", "#ffffff", "#ff5722"];

function Index() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null); // live overlay (cursors, hud)
  const inkRef = useRef<HTMLCanvasElement | null>(null); // persistent ink

  const strokesRef = useRef<Stroke[]>([]);
  const redoRef = useRef<Stroke[]>([]);
  const currentRef = useRef<Stroke | null>(null);

  // Smoothing
  const smoothRef = useRef<Pt | null>(null);
  const lastGestureRef = useRef<Gesture>("none");
  const clearHeldRef = useRef<number>(0);

  const colorRef = useRef<string>(COLORS[0]);
  const sizeRef = useRef<number>(10);

  const [color, setColor] = useState(COLORS[0]);
  const [size, setSize] = useState(10);
  const [gesture, setGesture] = useState<Gesture>("none");
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState("Loading hand tracking…");
  const [elapsed, setElapsed] = useState(0);
  const [recognizing, setRecognizing] = useState(false);
  const [recognized, setRecognized] = useState<string>("");
  const [fps, setFps] = useState(0);

  useEffect(() => {
    colorRef.current = color;
  }, [color]);
  useEffect(() => {
    sizeRef.current = size;
  }, [size]);

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
      ctx.shadowColor = "rgba(0,0,0,0.4)";
      ctx.shadowBlur = 3;
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) {
        ctx.lineTo(s.points[i].x, s.points[i].y);
      }
      if (s.points.length === 1) {
        // dot
        ctx.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }
    ctx.shadowBlur = 0;
  }, []);

  // Setup webcam + hand tracking
  useEffect(() => {
    let cancelled = false;
    let camera: any;
    let hands: any;
    let frames = 0;
    let fpsTimer: any;

    (async () => {
      try {
        await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
        await loadScript(
          "https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js",
        );
        if (cancelled) return;

        const video = videoRef.current!;
        const overlay = overlayRef.current!;
        const ink = inkRef.current!;
        const octx = overlay.getContext("2d")!;

        hands = new window.Hands({
          locateFile: (file: string) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
        });
        hands.setOptions({
          maxNumHands: 1,
          modelComplexity: 1,
          minDetectionConfidence: 0.6,
          minTrackingConfidence: 0.6,
        });

        fpsTimer = setInterval(() => {
          setFps(frames);
          frames = 0;
        }, 1000);

        hands.onResults((results: any) => {
          frames++;
          const w = overlay.width;
          const h = overlay.height;
          octx.clearRect(0, 0, w, h);

          let g: Gesture = "none";
          let tip: Pt | null = null;

          if (results.multiHandLandmarks && results.multiHandLandmarks[0]) {
            const lm = results.multiHandLandmarks[0];
            // Mirror because we mirror the video preview
            const mx = (p: any) => ({ x: (1 - p.x) * w, y: p.y * h });

            const indexTip = mx(lm[8]);
            const indexPip = mx(lm[6]);
            const middleTip = mx(lm[12]);
            const middlePip = mx(lm[10]);
            const ringTip = mx(lm[16]);
            const ringPip = mx(lm[14]);
            const pinkyTip = mx(lm[20]);
            const pinkyPip = mx(lm[18]);
            const thumbTip = mx(lm[4]);
            const wrist = mx(lm[0]);

            // A finger is "extended" if tip is farther from wrist than its PIP joint
            const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
            const ext = (tipP: Pt, pip: Pt) =>
              dist(tipP, wrist) > dist(pip, wrist) * 1.05;

            const iExt = ext(indexTip, indexPip);
            const mExt = ext(middleTip, middlePip);
            const rExt = ext(ringTip, ringPip);
            const pExt = ext(pinkyTip, pinkyPip);

            const extendedCount = [iExt, mExt, rExt, pExt].filter(Boolean).length;

            // Determine gesture
            if (iExt && !mExt && !rExt && !pExt) g = "draw";
            else if (iExt && mExt && !rExt && !pExt) g = "hover";
            else if (iExt && mExt && rExt && pExt) g = "clear"; // open palm
            else if (extendedCount === 0) g = "erase"; // fist erases near fingertip
            else g = "hover";

            // Smooth fingertip
            const target = indexTip;
            const prev = smoothRef.current;
            const alpha = 0.55;
            const sm = prev
              ? { x: prev.x * (1 - alpha) + target.x * alpha, y: prev.y * (1 - alpha) + target.y * alpha }
              : target;
            smoothRef.current = sm;
            tip = sm;

            // Stroke logic
            if (g === "draw") {
              if (!currentRef.current) {
                currentRef.current = { points: [], color: colorRef.current, size: sizeRef.current };
              }
              const pts = currentRef.current.points;
              const last = pts[pts.length - 1];
              if (!last || dist(last, tip) > 1.5) pts.push(tip);
            } else {
              if (currentRef.current) {
                strokesRef.current.push(currentRef.current);
                redoRef.current = [];
                currentRef.current = null;
              }
            }

            if (g === "erase" && tip) {
              const r = 30;
              strokesRef.current = strokesRef.current.filter((s) => {
                return !s.points.some((p) => dist(p, tip!) < r);
              });
            }

            // Open-palm-to-clear: must hold ~0.8s
            if (g === "clear") {
              clearHeldRef.current += 1;
              if (clearHeldRef.current > 24) {
                strokesRef.current = [];
                currentRef.current = null;
                redoRef.current = [];
                clearHeldRef.current = 0;
              }
            } else {
              clearHeldRef.current = 0;
            }

            // Draw cursor / hand markers
            const drawCircle = (p: Pt, r: number, fill: string, stroke?: string) => {
              octx.beginPath();
              octx.arc(p.x, p.y, r, 0, Math.PI * 2);
              octx.fillStyle = fill;
              octx.fill();
              if (stroke) {
                octx.strokeStyle = stroke;
                octx.lineWidth = 2;
                octx.stroke();
              }
            };

            // Skeleton: index finger line
            octx.strokeStyle = "rgba(255,255,255,0.6)";
            octx.lineWidth = 2;
            octx.beginPath();
            octx.moveTo(wrist.x, wrist.y);
            octx.lineTo(indexPip.x, indexPip.y);
            octx.lineTo(indexTip.x, indexTip.y);
            octx.stroke();

            // Cursor based on gesture
            if (g === "draw") {
              drawCircle(tip, sizeRef.current * 0.9, colorRef.current, "#000");
            } else if (g === "hover") {
              drawCircle(tip, 10, "rgba(255,255,255,0.2)", "#fff");
            } else if (g === "erase") {
              drawCircle(tip, 30, "rgba(255,0,0,0.15)", "#ff4444");
            } else if (g === "clear") {
              drawCircle(tip, 18, "rgba(34,255,102,0.25)", "#22ff66");
              // progress ring
              octx.strokeStyle = "#22ff66";
              octx.lineWidth = 4;
              octx.beginPath();
              octx.arc(
                tip.x,
                tip.y,
                26,
                -Math.PI / 2,
                -Math.PI / 2 + (clearHeldRef.current / 24) * Math.PI * 2,
              );
              octx.stroke();
            }
          } else {
            // No hand: commit any in-progress stroke
            if (currentRef.current) {
              strokesRef.current.push(currentRef.current);
              currentRef.current = null;
            }
            smoothRef.current = null;
            clearHeldRef.current = 0;
          }

          if (g !== lastGestureRef.current) {
            lastGestureRef.current = g;
            setGesture(g);
          }

          renderInk();
        });

        camera = new window.Camera(video, {
          onFrame: async () => {
            await hands.send({ image: video });
          },
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
        setStatus("Ready. Point with your index finger to draw.");
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
  }, [renderInk]);

  const clearAll = () => {
    strokesRef.current = [];
    currentRef.current = null;
    redoRef.current = [];
    renderInk();
    setRecognized("");
  };

  const undo = () => {
    const s = strokesRef.current.pop();
    if (s) redoRef.current.push(s);
    renderInk();
  };

  const redo = () => {
    const s = redoRef.current.pop();
    if (s) strokesRef.current.push(s);
    renderInk();
  };

  const savePng = () => {
    const video = videoRef.current!;
    const ink = inkRef.current!;
    const out = document.createElement("canvas");
    out.width = ink.width;
    out.height = ink.height;
    const ctx = out.getContext("2d")!;
    // Mirror video to match preview
    ctx.save();
    ctx.translate(out.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, out.width, out.height);
    ctx.restore();
    ctx.drawImage(ink, 0, 0);
    const a = document.createElement("a");
    a.download = `airink-${Date.now()}.png`;
    a.href = out.toDataURL("image/png");
    a.click();
  };

  const recognize = async () => {
    const ink = inkRef.current!;
    if (!ink) return;
    // Build white bg + black strokes image for the model
    const out = document.createElement("canvas");
    out.width = ink.width;
    out.height = ink.height;
    const ctx = out.getContext("2d")!;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#000";
    ctx.fillStyle = "#000";
    for (const s of strokesRef.current) {
      if (s.points.length < 1) continue;
      ctx.lineWidth = Math.max(s.size, 6);
      ctx.beginPath();
      ctx.moveTo(s.points[0].x, s.points[0].y);
      for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
      if (s.points.length === 1) {
        ctx.arc(s.points[0].x, s.points[0].y, s.size / 2, 0, Math.PI * 2);
        ctx.fill();
      } else ctx.stroke();
    }
    const dataUrl = out.toDataURL("image/png");
    try {
      setRecognizing(true);
      setRecognized("");
      const res = await fetch("/api/recognize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: dataUrl }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setRecognized(data.text || "(nothing recognized)");
    } catch (e: any) {
      setRecognized(`Error: ${e.message}`);
    } finally {
      setRecognizing(false);
    }
  };

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  const gestureLabel: Record<Gesture, { text: string; cls: string }> = {
    draw: { text: "DRAWING", cls: "bg-yellow-400 text-black" },
    hover: { text: "HOVER", cls: "bg-white/20 text-white" },
    erase: { text: "ERASING", cls: "bg-red-500 text-white" },
    clear: { text: "HOLD TO CLEAR", cls: "bg-emerald-500 text-black" },
    none: { text: "NO HAND", cls: "bg-zinc-700 text-zinc-300" },
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center gap-4 p-4">
      <header className="w-full max-w-6xl flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AirInk</h1>
          <p className="text-sm text-muted-foreground">
            Real-time air writing with gesture controls
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={undo} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
            Undo
          </button>
          <button onClick={redo} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
            Redo
          </button>
          <button onClick={clearAll} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
            Clear
          </button>
          <button onClick={savePng} className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
            Save PNG
          </button>
          <button
            onClick={recognize}
            disabled={recognizing || strokesRef.current.length === 0}
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
              className={`w-7 h-7 rounded-full border-2 ${color === c ? "border-white ring-2 ring-primary" : "border-white/30"}`}
              style={{ background: c }}
              aria-label={`color ${c}`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase text-muted-foreground">Brush</span>
          <input
            type="range"
            min={2}
            max={30}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            className="w-32"
          />
          <span className="text-xs tabular-nums w-6">{size}</span>
        </div>
        <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">{fps} fps</span>
          <span>·</span>
          <span className="font-mono">{mm}:{ss}</span>
        </div>
      </div>

      <div className="relative w-full max-w-6xl aspect-video bg-black rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10">
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover -scale-x-100"
        />
        <canvas ref={inkRef} className="absolute inset-0 w-full h-full pointer-events-none" />
        <canvas ref={overlayRef} className="absolute inset-0 w-full h-full pointer-events-none" />

        {/* HUD: gesture badge */}
        <div className="absolute top-4 left-4 flex items-center gap-2">
          <span className={`px-3 py-1 rounded-full text-xs font-bold tracking-wider ${gestureLabel[gesture].cls}`}>
            {gestureLabel[gesture].text}
          </span>
        </div>

        {/* HUD: timer */}
        <div className="absolute top-4 right-4 rounded-md bg-black/60 text-white px-3 py-1.5 text-lg font-mono tracking-wider">
          {mm}:{ss}
        </div>

        {/* Gesture legend */}
        <div className="absolute bottom-4 left-4 max-w-xs rounded-lg bg-black/60 text-white text-xs p-3 space-y-1 backdrop-blur">
          <div className="font-bold mb-1 text-[10px] uppercase tracking-wider opacity-70">Gestures</div>
          <div>☝️ Index only → <span className="text-yellow-300">Draw</span></div>
          <div>✌️ Index + middle → Hover</div>
          <div>✊ Fist → <span className="text-red-300">Erase</span> near tip</div>
          <div>🖐️ Open palm (hold) → <span className="text-emerald-300">Clear all</span></div>
        </div>

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-white text-sm">
            {status}
          </div>
        )}
      </div>

      {recognized && (
        <div className="w-full max-w-6xl rounded-lg border bg-card p-4">
          <div className="text-xs uppercase tracking-wider text-muted-foreground mb-1">
            AI recognized
          </div>
          <div className="text-2xl font-semibold break-words">{recognized}</div>
        </div>
      )}

      <p className="text-xs text-muted-foreground text-center max-w-2xl">
        Tip: hold your hand a comfortable distance from the camera. Use bold motions and pause briefly between letters for the cleanest recognition.
      </p>
    </div>
  );
}
