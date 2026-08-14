const assert = require("assert");
const {
  GROQ_MAX_PROMPT_TOKENS,
  estimatePromptTokens,
  buildGroqTranscriptionPrompt,
} = require("./groqPrompt");

const FIRESTORE_CANONICAL_PROMPT =
  "聞こえた内容をできるだけそのまま文字起こししてください。言い換えや補完はしないでください";

function runTests() {
  assert.strictEqual(buildGroqTranscriptionPrompt({}).prompt, null);
  assert.strictEqual(
    buildGroqTranscriptionPrompt({ userPrompt: "   " }).prompt,
    null,
  );

  const canonical = buildGroqTranscriptionPrompt({
    userPrompt: FIRESTORE_CANONICAL_PROMPT,
  });
  assert.strictEqual(canonical.prompt, FIRESTORE_CANONICAL_PROMPT);
  assert.strictEqual(canonical.truncated, false);
  assert.ok(canonical.prompt.includes("そのまま"));
  assert.ok(canonical.prompt.includes("言い換え"));
  assert.ok(canonical.prompt.includes("補完"));
  assert.ok(!canonical.prompt.includes("日本語文字起こし"));
  assert.ok(!canonical.prompt.includes("固有名詞:"));
  assert.ok(canonical.estimatedTokens <= GROQ_MAX_PROMPT_TOKENS);

  const properNounPrompt = buildGroqTranscriptionPrompt({
    userPrompt: "固有名詞: おはようカモメ、田中、札幌",
  });
  assert.strictEqual(
    properNounPrompt.prompt,
    "固有名詞: おはようカモメ、田中、札幌",
  );
  assert.strictEqual(properNounPrompt.truncated, false);

  const noisy = buildGroqTranscriptionPrompt({
    userPrompt:
      "要約しないでそのまま文字起こし。言い換えや補完はしないでください。",
  });
  assert.ok(noisy.prompt.includes("要約"));
  assert.ok(noisy.prompt.includes("そのまま"));
  assert.ok(noisy.prompt.includes("言い換え"));
  assert.ok(noisy.prompt.includes("補完"));
  assert.strictEqual(noisy.truncated, false);

  const longPrompt = "地名".repeat(400);
  const compressed = buildGroqTranscriptionPrompt({
    userPrompt: longPrompt,
  });
  assert.strictEqual(compressed.truncated, true);
  assert.ok(compressed.estimatedTokens <= GROQ_MAX_PROMPT_TOKENS);
  assert.ok(compressed.prompt.length < longPrompt.length);
  assert.ok(longPrompt.startsWith(compressed.prompt));

  const enPrompt = buildGroqTranscriptionPrompt({
    userPrompt: "Transcribe exactly as spoken. Do not rephrase.",
  });
  assert.strictEqual(
    enPrompt.prompt,
    "Transcribe exactly as spoken. Do not rephrase.",
  );
  assert.ok(!enPrompt.prompt.startsWith("Transcribe exactly. Names/places:"));

  const tokenEstimate = estimatePromptTokens("あいう");
  assert.ok(tokenEstimate >= 3);

  console.log("stt/groqPrompt.test.js: all tests passed");
}

runTests();
