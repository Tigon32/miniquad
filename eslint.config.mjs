/** ESLint flat configuration for Miniquad's browser-facing JavaScript.
 * Node syntax checking is also retained in CI.
 * Keep the initial rules focused on correctness, not stylistic rewrites.
 */
export default [
  {
    files: ["js/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        window: "readonly",
        document: "readonly",
        console: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        queueMicrotask: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly"
      }
    },
    rules: {
      "no-undef": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error"
    }
  },
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        console: "readonly",
        performance: "readonly",
        alert: "readonly",
        requestAnimationFrame: "readonly",
        cancelAnimationFrame: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        fetch: "readonly",
        Image: "readonly",
        XMLHttpRequest: "readonly",
        WebAssembly: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        atob: "readonly",
        btoa: "readonly"
      }
    },
    rules: {
      "no-undef": "error",
      "no-dupe-args": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unsafe-finally": "error",
      "no-invalid-regexp": "error",
      "no-fallthrough": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      "no-unused-vars": "off"
    }
  }
];
