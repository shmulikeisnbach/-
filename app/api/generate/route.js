import { NextResponse } from "next/server";

// ---- config ----
const DAILY_FREE_LIMIT = parseInt(process.env.DAILY_FREE_LIMIT || "10", 10);
const MAX_PROMPT_CHARS = 12000; // cheap abuse guard - blocks absurdly long injected prompts
const GEMINI_MODEL = "gemini-3.6-flash";

// In-memory fallback counter (works for local dev / single instance only).
// In real production on Vercel, set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
// (free tier at upstash.com) so the counter is shared across serverless invocations.
const memoryCounts = new Map();

function todayKey(ip) {
  const day = new Date().toISOString().slice(0, 10);
  return `usage:${ip}:${day}`;
}

async function getAndIncrementUsage(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  const key = todayKey(ip);

  if (url && token) {
    // Upstash REST: INCR then EXPIRE (idempotent-ish, fine for a rate limiter)
    const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const incrData = await incrRes.json();
    const count = incrData.result;
    if (count === 1) {
      await fetch(`${url}/expire/${encodeURIComponent(key)}/86400`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    }
    return count;
  }

  // fallback: in-memory (NOT reliable across multiple serverless instances)
  const current = (memoryCounts.get(key) || 0) + 1;
  memoryCounts.set(key, current);
  return current;
}

function getClientIp(req) {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req) {
  try {
    const body = await req.json();
    const { systemPrompt, userPrompt, temperature, userApiKey } = body || {};

    if (!systemPrompt || !userPrompt) {
      return NextResponse.json({ error: "חסרים שדות חובה בבקשה." }, { status: 400 });
    }
    if (systemPrompt.length > MAX_PROMPT_CHARS || userPrompt.length > MAX_PROMPT_CHARS) {
      return NextResponse.json({ error: "הבקשה ארוכה מדי." }, { status: 400 });
    }

    const ip = getClientIp(req);
    let apiKeyToUse = process.env.GEMINI_API_KEY;

    // If the visitor supplied their own key, let them bypass the shared daily limit.
    if (userApiKey && userApiKey.trim().length > 10) {
      apiKeyToUse = userApiKey.trim();
    } else {
      const count = await getAndIncrementUsage(ip);
      if (count > DAILY_FREE_LIMIT) {
        return NextResponse.json(
          {
            error: `הגעת למכסת ${DAILY_FREE_LIMIT} הניסוחים החינמיים היומית שלך. נסה שוב מחר, או הזן מפתח Gemini API אישי (חינמי) לשימוש ללא הגבלה.`,
            limitReached: true,
          },
          { status: 429 }
        );
      }
    }

    if (!apiKeyToUse) {
      return NextResponse.json(
        { error: "השרת לא מוגדר עם מפתח API (חסר GEMINI_API_KEY בסביבת השרת)." },
        { status: 500 }
      );
    }

    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKeyToUse,
        },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: typeof temperature === "number" ? temperature : 1.0,
            maxOutputTokens: 3500,
          },
        }),
      }
    );

    if (!resp.ok) {
      const errData = await resp.json().catch(() => ({}));
      return NextResponse.json(
        { error: errData?.error?.message || `שגיאת שרת Gemini (${resp.status})` },
        { status: 502 }
      );
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("").trim();
    if (!text) {
      return NextResponse.json({ error: "לא התקבל טקסט מהמודל - נסה שוב." }, { status: 502 });
    }

    return NextResponse.json({ text });
  } catch (err) {
    return NextResponse.json({ error: "שגיאה כללית בשרת: " + err.message }, { status: 500 });
  }
}
