import assert from "node:assert/strict";
import test from "node:test";
import { shouldIncludeHardwareGpuProject } from "../scripts/playwright-projects.mjs";

test("hardware GPU timer-query project is opt-in", () => {
  assert.equal(shouldIncludeHardwareGpuProject(undefined, undefined), false);
  assert.equal(shouldIncludeHardwareGpuProject(undefined, "1"), true);
  assert.equal(shouldIncludeHardwareGpuProject("chromium", "1"), true);
  assert.equal(shouldIncludeHardwareGpuProject("firefox", "1"), false);
  assert.equal(shouldIncludeHardwareGpuProject(undefined, "true"), false);
});
