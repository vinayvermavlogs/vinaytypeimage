import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/recognize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const key = process.env.LOVABLE_API_KEY;
        if (!key) return new Response("Missing LOVABLE_API_KEY", { status: 500 });
        const { imageBase64 } = (await request.json()) as { imageBase64: string };
        if (!imageBase64) return new Response("Missing imageBase64", { status: 400 });

        const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-flash",
            messages: [
              {
                role: "system",
                content:
                  "You read handwritten characters drawn as black strokes on a white background. Reply with ONLY the recognized text — no quotes, no explanation. If nothing is readable, reply with an empty string.",
              },
              {
                role: "user",
                content: [
                  { type: "text", text: "What does this handwriting say?" },
                  { type: "image_url", image_url: { url: imageBase64 } },
                ],
              },
            ],
          }),
        });
        if (!res.ok) {
          return new Response(await res.text(), { status: res.status });
        }
        const data: any = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim?.() ?? "";
        return new Response(JSON.stringify({ text }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  },
});
