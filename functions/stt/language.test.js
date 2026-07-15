const assert = require("assert");
const {
  STT_LANGUAGE_JA,
  STT_LANGUAGE_EN,
  normalizeSttLanguageValue,
  resolveSttLanguage,
  toGoogleLanguageCode,
  toOpenAiLanguage,
  resolveProviderLanguage,
} = require("./language");
const { STT_PROVIDER_OPENAI, STT_PROVIDER_GOOGLE } = require("./constants");

function runTests() {
  assert.strictEqual(normalizeSttLanguageValue(undefined), STT_LANGUAGE_JA);
  assert.strictEqual(normalizeSttLanguageValue(null), STT_LANGUAGE_JA);
  assert.strictEqual(normalizeSttLanguageValue(""), STT_LANGUAGE_JA);
  assert.strictEqual(normalizeSttLanguageValue("   "), STT_LANGUAGE_JA);
  assert.strictEqual(normalizeSttLanguageValue("ja"), STT_LANGUAGE_JA);
  assert.strictEqual(normalizeSttLanguageValue("EN"), STT_LANGUAGE_EN);

  const jaResolved = resolveSttLanguage("ja");
  assert.strictEqual(jaResolved.ok, true);
  assert.strictEqual(jaResolved.language, STT_LANGUAGE_JA);

  const enResolved = resolveSttLanguage("en");
  assert.strictEqual(enResolved.ok, true);
  assert.strictEqual(enResolved.language, STT_LANGUAGE_EN);

  const unsetResolved = resolveSttLanguage(undefined);
  assert.strictEqual(unsetResolved.ok, true);
  assert.strictEqual(unsetResolved.language, STT_LANGUAGE_JA);

  const emptyResolved = resolveSttLanguage("");
  assert.strictEqual(emptyResolved.ok, true);
  assert.strictEqual(emptyResolved.language, STT_LANGUAGE_JA);

  const invalidResolved = resolveSttLanguage("fr");
  assert.strictEqual(invalidResolved.ok, false);
  assert.strictEqual(invalidResolved.code, "STT_LANGUAGE_INVALID");

  assert.strictEqual(toGoogleLanguageCode(STT_LANGUAGE_JA), "ja-JP");
  assert.strictEqual(toGoogleLanguageCode(STT_LANGUAGE_EN), "en-US");
  assert.strictEqual(toOpenAiLanguage(STT_LANGUAGE_JA), "ja");
  assert.strictEqual(toOpenAiLanguage(STT_LANGUAGE_EN), "en");

  assert.strictEqual(
    resolveProviderLanguage(STT_PROVIDER_GOOGLE, STT_LANGUAGE_JA),
    "ja-JP",
  );
  assert.strictEqual(
    resolveProviderLanguage(STT_PROVIDER_GOOGLE, STT_LANGUAGE_EN),
    "en-US",
  );
  assert.strictEqual(
    resolveProviderLanguage(STT_PROVIDER_OPENAI, STT_LANGUAGE_JA),
    "ja",
  );
  assert.strictEqual(
    resolveProviderLanguage(STT_PROVIDER_OPENAI, STT_LANGUAGE_EN),
    "en",
  );

  console.log("stt/language.test.js: all tests passed");
}

runTests();
