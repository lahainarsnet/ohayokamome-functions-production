const assert = require("assert");
const { resolveSttProvider, normalizeSttProviderValue } = require("./registry");

function runTests() {
  assert.strictEqual(normalizeSttProviderValue(undefined), "openai");
  assert.strictEqual(normalizeSttProviderValue(null), "openai");
  assert.strictEqual(normalizeSttProviderValue(""), "openai");
  assert.strictEqual(normalizeSttProviderValue("   "), "openai");
  assert.strictEqual(normalizeSttProviderValue("openai"), "openai");
  assert.strictEqual(normalizeSttProviderValue("OpenAI"), "openai");

  const openaiResolved = resolveSttProvider("openai");
  assert.strictEqual(openaiResolved.ok, true);
  assert.strictEqual(openaiResolved.provider, "openai");

  const unsetResolved = resolveSttProvider(undefined);
  assert.strictEqual(unsetResolved.ok, true);
  assert.strictEqual(unsetResolved.provider, "openai");

  const emptyResolved = resolveSttProvider("");
  assert.strictEqual(emptyResolved.ok, true);
  assert.strictEqual(emptyResolved.provider, "openai");

  const googleResolved = resolveSttProvider("google");
  assert.strictEqual(googleResolved.ok, false);
  assert.strictEqual(googleResolved.code, "STT_PROVIDER_INVALID");
  assert.strictEqual(googleResolved.provider, "google");

  const typoResolved = resolveSttProvider("openai2");
  assert.strictEqual(typoResolved.ok, false);
  assert.strictEqual(typoResolved.code, "STT_PROVIDER_INVALID");

  console.log("stt/registry.test.js: all tests passed");
}

runTests();
