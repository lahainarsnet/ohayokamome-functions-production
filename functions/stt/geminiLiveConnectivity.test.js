/**
 * Optional live Gemini connectivity check.
 * Run: GEMINI_LIVE_CONNECTIVITY_TEST=1 node stt/geminiLiveConnectivity.test.js
 * Requires GEMINI_API_KEY in env, or firebase functions:secrets:access.
 */
const assert = require("assert");
const { execFileSync } = require("child_process");
const {
  GEMINI_TRANSCRIBE_MODEL,
  STT_PROVIDER_GEMINI,
} = require("./constants");
const {
  buildGenerateContentBody,
  buildGeminiTranscribeInstruction,
  transcribeWithGemini,
} = require("./geminiProvider");

function loadGeminiApiKey() {
  if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.trim() !== "") {
    return process.env.GEMINI_API_KEY.trim();
  }
  const raw = execFileSync(
    "firebase",
    [
      "functions:secrets:access",
      "GEMINI_API_KEY",
      "--project",
      "lahainarsnet-ohayokamome-live",
    ],
    { encoding: "utf8" },
  );
  return raw.trim();
}

async function runTests() {
  if (process.env.GEMINI_LIVE_CONNECTIVITY_TEST !== "1") {
    console.log(
      "stt/geminiLiveConnectivity.test.js: skipped (set GEMINI_LIVE_CONNECTIVITY_TEST=1 to run)",
    );
    return;
  }

  assert.strictEqual(GEMINI_TRANSCRIBE_MODEL, "gemini-3.5-flash-lite");

  const apiKey = loadGeminiApiKey();
  assert.ok(apiKey.length >= 20, "GEMINI_API_KEY must be present");

  const textBody = {
    contents: [{ parts: [{ text: "Reply with exactly: ok" }] }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 16,
      thinkingConfig: { thinkingLevel: "minimal" },
    },
  };
  const textUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const textResponse = await fetch(textUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(textBody),
  });
  const textJson = await textResponse.json();
  assert.strictEqual(
    textResponse.status,
    200,
    `text-only generateContent failed: ${JSON.stringify(textJson?.error || textJson)}`,
  );
  assert.ok(
    textJson?.candidates?.[0]?.content?.parts?.[0]?.text,
    "text-only response must include candidate text",
  );

  const providerBody = buildGenerateContentBody({
    instruction: buildGeminiTranscribeInstruction("ja"),
    audioBase64: Buffer.from("fake-audio").toString("base64"),
    mimeType: "audio/mp4",
  });
  assert.strictEqual(
    providerBody.generationConfig.thinkingConfig.thinkingLevel,
    "minimal",
  );

  const providerResult = await transcribeWithGemini({
    audioBuffer: Buffer.from("fake-audio"),
    mimeType: "audio/mp4",
    language: "ja",
    apiKey,
    receivedBytes: 10,
  });
  assert.ok(
    providerResult.ok === true ||
      providerResult.code === "GEMINI_INVALID_AUDIO" ||
      providerResult.code === "GEMINI_HTTP_ERROR" ||
      providerResult.code === "GEMINI_EMPTY_TRANSCRIPT",
    `unexpected provider result: ${providerResult.code}`,
  );
  assert.strictEqual(providerResult.provider, STT_PROVIDER_GEMINI);
  assert.strictEqual(providerResult.model, GEMINI_TRANSCRIBE_MODEL);

  console.log("stt/geminiLiveConnectivity.test.js: live checks passed");
  console.log(
    `text-only status=200 providerProbe=${providerResult.ok ? "success" : providerResult.code}`,
  );
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
