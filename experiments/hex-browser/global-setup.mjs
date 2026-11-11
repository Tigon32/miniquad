// Playwright globalSetup: builds both WASM variants once before any
// test file runs, so the fixtures are always fresh and real (never a
// silently reused stale build) per the harness's hermetic-fixture
// requirement.
import { buildHexFixtures } from "./build-fixtures.mjs";

export default async function globalSetup() {
    buildHexFixtures();
}
