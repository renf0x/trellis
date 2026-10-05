import { test } from "node:test";
import assert from "node:assert/strict";
import { mobileAgent, screenFor } from "./index.ts";

test("screenFor: presets, a bare width and the desktop reset", () => {
  assert.deepEqual(screenFor({ preset: "mobile" }), { width: 360, height: 800, mobile: true, label: "360×800, мобильная версия" });
  assert.equal(screenFor({ width: 360 })?.mobile, true);
  assert.equal(screenFor({ width: 1280 })?.mobile, false);
  assert.equal(screenFor({ width: 1024, mobile: true })?.label, "1024×1365, мобильная версия");
  assert.equal(screenFor({ preset: "laptop" })?.label, "1366×768");
  assert.equal(screenFor({ preset: "desktop" }), null);
  assert.throws(() => screenFor({ width: 50 }), /от 200 до 3840/);
  assert.throws(() => screenFor({}), /от 200 до 3840/);
});

test("mobileAgent keeps the browser version and says Android with client hints", () => {
  const brands = [{ brand: "Chromium", version: "141" }];
  const chrome = mobileAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", brands);
  assert.match(chrome.userAgent, /Android 10.*Chrome\/141\.0\.0\.0 Mobile Safari/);
  assert.deepEqual(chrome.userAgentMetadata, { brands, platform: "Android", platformVersion: "10.0.0", architecture: "", model: "K", mobile: true });
  const edge = mobileAgent("… Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57", brands);
  assert.match(edge.userAgent, /EdgA\/141\.0\.0\.0$/);
});
