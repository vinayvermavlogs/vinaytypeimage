import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Air Writing — Finger Typing Detection" },
      { name: "description", content: "Write in the air with your index finger. Real-time hand tracking draws your strokes onto the webcam feed." },
      { property: "og:title", content: "Air Writing — Finger Typing Detection" },
      { property: "og:description", content: "Write in the air with your index finger. Real-time hand tracking draws your strokes onto the webcam feed." },
    ],
  }),
  component: Index,
});

type Pt = { x: number; y: number };
type Stroke = Pt[];

// MediaPipe Hands via CDN globals
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

function Index() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<Stroke | null>(null);
  const lastPinchRef = useRef(false);

  const [muted, setMuted] = useState(true);
  const [elapsed, setElapsed] = useState(0);
  const [status, setStatus] = useState("Loading hand tracking…");
  const [ready, setReady] = useState(false);

  // Timer
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, [ready]);

  useEffect(() => {
    let cancelled = false;
    let camera: any;
    let hands: any;

    (async () => {
      try {
        await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js");
        await loadScript("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
        if (cancelled) return;

        const video = videoRef.current!;
        const canvas = canvasRef.current!;
        const ctx = canvas.getContext("2d")!;

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

        hands.onResults((results: any) => {
          const w = canvas.width;
          const h = canvas.height;
          ctx.clearRect(0, 0, w, h);

          // ROI box (bottom-right)
          const roi = {
            x: w * 0.66,
            y: h * 0.35,
            w: w * 0.32,
            h: h * 0.55,
          };
          ctx.strokeStyle = "#ff00d4";
          ctx.lineWidth = 3;
          ctx.strokeRect(roi.x, roi.y, roi.w, roi.h);

          let tipPx: Pt | null = null;
          let thumbPx: Pt | null = null;

          if (results.multiHandLandmarks && results.multiHandLandmarks[0]) {
            const lm = results.multiHandLandmarks[0];
            // Mirror x because video is mirrored
            const tip = lm[8];
            const thumb = lm[4];
            tipPx = { x: (1 - tip.x) * w, y: tip.y * h };
            thumbPx = { x: (1 - thumb.x) * w, y: thumb.y * h };

            // Draw skeleton inside ROI (index + thumb line) — pink
            if (
              tipPx.x >= roi.x &&
              tipPx.x <= roi.x + roi.w &&
              tipPx.y >= roi.y &&
              tipPx.y <= roi.y + roi.h
            ) {
              ctx.strokeStyle = "#ff00d4";
              ctx.lineWidth = 3;
              ctx.beginPath();
              ctx.moveTo(thumbPx.x, thumbPx.y);
              ctx.lineTo(tipPx.x, tipPx.y);
              ctx.stroke();

              // Yellow fingertip dot
              ctx.fillStyle = "#fff200";
              ctx.beginPath();
              ctx.arc(tipPx.x, tipPx.y, 14, 0, Math.PI * 2);
              ctx.fill();

              // Green thumb dot
              ctx.fillStyle = "#22ff66";
              ctx.beginPath();
              ctx.arc(thumbPx.x, thumbPx.y, 8, 0, Math.PI * 2);
              ctx.fill();
            }
          }

          // Pinch logic: index tip close to thumb tip = pen down
          let pinch = false;
          if (tipPx && thumbPx) {
            const d = Math.hypot(tipPx.x - thumbPx.x, tipPx.y - thumbPx.y);
            pinch = d < Math.min(w, h) * 0.06;
          }

          // Default mode: draw when index is extended and roughly pointing
          // Simpler: draw whenever a hand is visible AND user is NOT pinching
          // (pinch = lift pen). This lets users write freely.
          const drawing = !!tipPx && !pinch;

          if (drawing && tipPx) {
            if (!lastPinchRef.current && currentStrokeRef.current === null) {
              currentStrokeRef.current = [];
              strokesRef.current.push(currentStrokeRef.current);
            }
            if (currentStrokeRef.current) {
              const last = currentStrokeRef.current[currentStrokeRef.current.length - 1];
              if (!last || Math.hypot(last.x - tipPx.x, last.y - tipPx.y) > 2) {
                currentStrokeRef.current.push(tipPx);
              }
            }
          } else {
            currentStrokeRef.current = null;
          }
          lastPinchRef.current = pinch;

          // Render all yellow strokes
          ctx.strokeStyle = "#fff200";
          ctx.lineWidth = 14;
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          ctx.shadowColor = "rgba(0,0,0,0.35)";
          ctx.shadowBlur = 4;
          for (const stroke of strokesRef.current) {
            if (stroke.length < 2) continue;
            ctx.beginPath();
            ctx.moveTo(stroke[0].x, stroke[0].y);
            for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x, stroke[i].y);
            ctx.stroke();
          }
          ctx.shadowBlur = 0;
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

        // Match canvas to video intrinsic size once loaded
        const sync = () => {
          if (!video.videoWidth) return;
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        };
        if (video.readyState >= 2) sync();
        else video.addEventListener("loadedmetadata", sync, { once: true });

        setReady(true);
        setStatus("Pinch index + thumb to lift pen. Move finger to draw.");
      } catch (e: any) {
        setStatus(e?.message ?? "Failed to start. Allow camera access.");
      }
    })();

    return () => {
      cancelled = true;
      try { camera?.stop?.(); } catch {}
      try { hands?.close?.(); } catch {}
    };
  }, []);

  const clear = () => {
    strokesRef.current = [];
    currentStrokeRef.current = null;
  };

  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col items-center gap-4 p-4">
      <header className="w-full max-w-5xl flex items-center justify-between">
        <h1 className="text-xl font-semibold">Air Writing — finger typing detection</h1>
        <button
          onClick={clear}
          className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm hover:opacity-90"
        >
          Clear
        </button>
      </header>

      <div
        ref={containerRef}
        className="relative w-full max-w-5xl aspect-video bg-black rounded-lg overflow-hidden shadow-xl"
      >
        <video
          ref={videoRef}
          playsInline
          muted
          className="absolute inset-0 w-full h-full object-cover -scale-x-100"
        />
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full pointer-events-none"
        />

        {/* Timer pill */}
        <div className="absolute top-4 right-4 rounded-md bg-black/60 text-white px-3 py-1.5 text-lg font-mono tracking-wider">
          {mm}:{ss}
        </div>

        {/* Mute / sound */}
        <button
          onClick={() => setMuted((m) => !m)}
          className="absolute bottom-4 right-4 w-12 h-12 rounded-full bg-black/70 text-white flex items-center justify-center hover:bg-black/80"
          aria-label={muted ? "Unmute" : "Mute"}
        >
          {muted ? (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
          ) : (
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.23v2.06A7 7 0 0 1 14 18.7v2.06A9 9 0 0 0 14 3.23z"/></svg>
          )}
        </button>

        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 text-white text-sm">
            {status}
          </div>
        )}
      </div>

      <p className="text-sm text-muted-foreground max-w-2xl text-center">
        {status} Hold your hand up so the index fingertip (yellow dot) appears inside the pink box.
        Pinch your index finger to your thumb to lift the pen.
      </p>
    </div>
  );
}
