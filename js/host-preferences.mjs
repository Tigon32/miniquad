// Host preference adapter for Miniquad embeddings (issue #122).
//
// This module is dependency-free. It does not import js/gl.js, js/miniquad.mjs,
// or any runtime module. It only reads browser preference signals (matchMedia,
// CSS custom properties, URL query values) and forwards a small, bounded,
// typed parameter set to an application handle supplied by the host.
//
// The application handle contract (frozen for this adapter) is the mount
// handle described in docs/host-preferences.md:
//   { ready, state, pause(), resume(), focus(), dispose(),
//     setParameters(partial), supportsParameters }
//
// setParameters accepts ONLY these keys: speed, foreground, background.
// Any other key is rejected as an explicit error. This adapter never widens
// that schema and never guesses an unsupported command.

const SPEED_MIN = 0;
const SPEED_MAX = 2;
const COLOR_MIN = 0;
const COLOR_MAX = 1;
const COLOR_LENGTH = 4;

const RESOLUTION_MIN = 8;
const RESOLUTION_MAX = 56;
const RESOLUTION_STEP = 4;

const PARAMETER_KEYS = ["speed", "foreground", "background"];
const URL_KEYS = ["scene", "look", "view", "resolution", "speed"];
const LOOK_VALUES = ["light", "dark", "high-contrast"];
const VIEW_VALUES = ["default", "debug"];
const SCENE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const MOTION_OVERRIDES = ["auto", "paused", "running"];

function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
}

function inRange(value, min, max) {
    return isFiniteNumber(value) && value >= min && value <= max;
}

/**
 * Validate one candidate speed value.
 * Returns a finite number in [SPEED_MIN, SPEED_MAX], or throws a TypeError.
 */
function validateSpeed(value) {
    if (!inRange(value, SPEED_MIN, SPEED_MAX)) {
        throw new TypeError(
            "speed must be a finite number in [" + SPEED_MIN + ", " + SPEED_MAX + "], got " + String(value)
        );
    }
    return value;
}

/**
 * Validate one candidate RGBA color array.
 * Returns a new array of 4 finite floats in [0, 1], or throws a TypeError.
 */
function validateColor(value, label) {
    if (!Array.isArray(value) || value.length !== COLOR_LENGTH) {
        throw new TypeError(label + " must be an array of " + COLOR_LENGTH + " finite numbers in [0, 1]");
    }
    const out = new Array(COLOR_LENGTH);
    for (let index = 0; index < COLOR_LENGTH; index += 1) {
        const component = value[index];
        if (!inRange(component, COLOR_MIN, COLOR_MAX)) {
            throw new TypeError(
                label + "[" + index + "] must be a finite number in [0, 1], got " + String(component)
            );
        }
        out[index] = component;
    }
    return out;
}

/**
 * Validate a partial setParameters() payload.
 *
 * Only "speed", "foreground", and "background" are recognized. Unknown keys
 * are reported as explicit errors, never ignored. Each key is validated
 * independently: a key that fails validation is omitted from `value` and
 * reported in `errors`. There is no fallback substitution for an invalid
 * value; the caller must treat a reported error as the authoritative result
 * for that key.
 *
 * @param {object} partial candidate parameters
 * @returns {{value: object, errors: Array<{key: string, message: string}>}}
 */
export function validateParameters(partial) {
    const value = {};
    const errors = [];
    if (partial === null || typeof partial !== "object") {
        return { value, errors: [{ key: "*", message: "parameters must be an object" }] };
    }
    for (const key of Object.keys(partial)) {
        if (!PARAMETER_KEYS.includes(key)) {
            errors.push({ key, message: "unknown parameter key: " + key });
        }
    }
    if (Object.prototype.hasOwnProperty.call(partial, "speed")) {
        try {
            value.speed = validateSpeed(partial.speed);
        } catch (error) {
            errors.push({ key: "speed", message: error.message });
        }
    }
    if (Object.prototype.hasOwnProperty.call(partial, "foreground")) {
        try {
            value.foreground = validateColor(partial.foreground, "foreground");
        } catch (error) {
            errors.push({ key: "foreground", message: error.message });
        }
    }
    if (Object.prototype.hasOwnProperty.call(partial, "background")) {
        try {
            value.background = validateColor(partial.background, "background");
        } catch (error) {
            errors.push({ key: "background", message: error.message });
        }
    }
    return { value, errors };
}

/**
 * Parse a CSS color string into an RGBA array of 4 finite floats in [0, 1].
 *
 * Supports only: #rgb, #rgba, #rrggbb, #rrggbbaa hex forms, rgb()/rgba()
 * with integer or percentage components, and the "transparent" keyword.
 * This is a closed-form regex parser. It does not evaluate CSS, does not
 * resolve "currentcolor", and does not support named colors beyond
 * "transparent". An unsupported or malformed string throws a TypeError;
 * it never falls back to a guessed color.
 *
 * @param {string} input a CSS color value
 * @returns {number[]} [r, g, b, a] each in [0, 1]
 */
export function parseCssColor(input) {
    if (typeof input !== "string") {
        throw new TypeError("CSS color must be a string, got " + typeof input);
    }
    const text = input.trim();
    if (text.length === 0) {
        throw new TypeError("CSS color must not be empty");
    }
    if (text.toLowerCase() === "transparent") {
        return [0, 0, 0, 0];
    }
    const hexMatch = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(text);
    if (hexMatch) {
        let digits = hexMatch[1];
        if (digits.length === 3 || digits.length === 4) {
            digits = digits.split("").map((character) => character + character).join("");
        }
        if (digits.length === 6) {
            digits += "ff";
        }
        const r = parseInt(digits.slice(0, 2), 16) / 255;
        const g = parseInt(digits.slice(2, 4), 16) / 255;
        const b = parseInt(digits.slice(4, 6), 16) / 255;
        const a = parseInt(digits.slice(6, 8), 16) / 255;
        return [r, g, b, a];
    }
    const functionMatch = /^(rgba?)\(\s*([^)]*)\)$/i.exec(text);
    if (functionMatch) {
        const parts = functionMatch[2].split(/[,\s/]+/).filter((part) => part.length > 0);
        if (parts.length !== 3 && parts.length !== 4) {
            throw new TypeError("rgb()/rgba() needs 3 or 4 components, got " + String(input));
        }
        const components = parts.map((part, index) => {
            const isAlpha = index === 3;
            const percent = /^-?[0-9.]+%$/.exec(part);
            const plain = /^-?[0-9.]+$/.exec(part);
            if (percent) {
                const ratio = parseFloat(part.slice(0, -1)) / 100;
                return ratio;
            }
            if (plain) {
                const amount = parseFloat(part);
                return isAlpha ? amount : amount / 255;
            }
            throw new TypeError("unsupported color component: " + part);
        });
        const [r, g, b] = components;
        const a = components.length === 4 ? components[3] : 1;
        return validateColor([r, g, b, a], "parsed color");
    }
    throw new TypeError(
        "unsupported CSS color syntax: " + String(input) + " (only hex, rgb()/rgba(), and transparent are supported)"
    );
}

function clampValidation(condition, message) {
    if (!condition) {
        throw new TypeError(message);
    }
}

/**
 * Parse and validate host URL state.
 *
 * Only these keys are recognized: scene, look, view, resolution, speed.
 * Any other key, or any value outside its narrow typed range, is reported
 * as an explicit error. There is no silent fallback to a default value:
 * a rejected key is simply absent from `values`, and its problem is listed
 * in `errors` so the host can show it.
 *
 * - scene: lowercase identifier, pattern ^[a-z][a-z0-9-]{0,31}$
 * - look: one of "light", "dark", "high-contrast"
 * - view: one of "default", "debug"
 * - resolution: integer in [8, 56], step 4 (8, 12, 16, ..., 56)
 * - speed: finite number in [0, 2]
 *
 * `resolution` is parsed and validated for host display only. This adapter
 * does not forward it through setParameters(); the shared renderer schema
 * (issue #122) currently supports only speed, foreground, and background.
 *
 * @param {string|URLSearchParams} search a query string or URLSearchParams
 * @returns {{values: object, errors: Array<{key: string, message: string}>}}
 */
export function parseHostURLState(search) {
    const params = search instanceof URLSearchParams ? search : new URLSearchParams(String(search ?? ""));
    const values = {};
    const errors = [];
    for (const key of params.keys()) {
        if (!URL_KEYS.includes(key)) {
            errors.push({ key, message: "unknown URL state key: " + key });
        }
    }
    const scene = params.get("scene");
    if (scene !== null) {
        try {
            clampValidation(SCENE_PATTERN.test(scene), "scene must match " + SCENE_PATTERN + ", got " + scene);
            values.scene = scene;
        } catch (error) {
            errors.push({ key: "scene", message: error.message });
        }
    }
    const look = params.get("look");
    if (look !== null) {
        try {
            clampValidation(LOOK_VALUES.includes(look), "look must be one of " + LOOK_VALUES.join(", ") + ", got " + look);
            values.look = look;
        } catch (error) {
            errors.push({ key: "look", message: error.message });
        }
    }
    const view = params.get("view");
    if (view !== null) {
        try {
            clampValidation(VIEW_VALUES.includes(view), "view must be one of " + VIEW_VALUES.join(", ") + ", got " + view);
            values.view = view;
        } catch (error) {
            errors.push({ key: "view", message: error.message });
        }
    }
    const resolution = params.get("resolution");
    if (resolution !== null) {
        try {
            const parsed = Number(resolution);
            clampValidation(
                Number.isInteger(parsed) && parsed >= RESOLUTION_MIN && parsed <= RESOLUTION_MAX && (parsed - RESOLUTION_MIN) % RESOLUTION_STEP === 0,
                "resolution must be an integer in [" + RESOLUTION_MIN + ", " + RESOLUTION_MAX + "] in steps of " + RESOLUTION_STEP + ", got " + resolution
            );
            values.resolution = parsed;
        } catch (error) {
            errors.push({ key: "resolution", message: error.message });
        }
    }
    const speed = params.get("speed");
    if (speed !== null) {
        try {
            const parsed = Number(speed);
            values.speed = validateSpeed(parsed);
        } catch (error) {
            errors.push({ key: "speed", message: error.message });
        }
    }
    return { values, errors };
}

const COLOR_PROPERTIES = {
    foreground: "--miniquad-foreground",
    background: "--miniquad-background"
};

/**
 * Read the host palette from CSS custom properties on `element`.
 * Reads `--miniquad-foreground` and `--miniquad-background`. A property that
 * is unset is omitted. A property that is set but does not parse as a
 * supported CSS color is reported in `errors`, never silently dropped.
 *
 * @param {Element} element element to read computed custom properties from
 * @param {Window} view the window whose getComputedStyle resolves the element
 * @returns {{value: object, errors: Array<{key: string, message: string}>}}
 */
export function readPalette(element, view) {
    const value = {};
    const errors = [];
    if (!element || typeof view?.getComputedStyle !== "function") {
        return { value, errors };
    }
    const computed = view.getComputedStyle(element);
    for (const [key, property] of Object.entries(COLOR_PROPERTIES)) {
        const raw = computed.getPropertyValue(property);
        if (!raw || raw.trim().length === 0) {
            continue;
        }
        try {
            value[key] = parseCssColor(raw);
        } catch (error) {
            errors.push({ key, message: "custom property " + property + ": " + error.message });
        }
    }
    return { value, errors };
}

function readMediaState(view) {
    const query = (condition) => (typeof view?.matchMedia === "function" ? view.matchMedia(condition) : null);
    const colorScheme = query("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
    const reducedMotion = query("(prefers-reduced-motion: reduce)")?.matches === true;
    const forcedColors = query("(forced-colors: active)")?.matches === true;
    let contrast = "no-preference";
    if (query("(prefers-contrast: more)")?.matches) {
        contrast = "more";
    } else if (query("(prefers-contrast: less)")?.matches) {
        contrast = "less";
    } else if (query("(prefers-contrast: custom)")?.matches) {
        contrast = "custom";
    }
    return { colorScheme, reducedMotion, forcedColors, contrast };
}

function reportError(onError, error) {
    if (typeof onError === "function") {
        onError(error instanceof Error ? error : new Error(String(error)));
        return;
    }
    // No listener was supplied. An invalid value must stay visible, so this
    // re-throws asynchronously rather than swallowing the problem.
    queueMicrotask(() => {
        throw error instanceof Error ? error : new Error(String(error));
    });
}

/**
 * Call one method on the application handle, catching only a synchronous
 * throw from that single call. The original error is reported through
 * `onError` with an actionable message naming the method, and kept as
 * `cause` for inspection. This never swallows the error: it is always
 * surfaced, never silently dropped. It never catches anything outside the
 * named call (for example errors from `onError` itself, or from unrelated
 * adapter code), so it does not widen into a broad try/catch around this
 * module.
 */
function invokeApplicationMethod(application, method, args, onError) {
    try {
        return application[method](...args);
    } catch (error) {
        reportError(onError, new Error(
            "application." + method + "() threw: " + (error instanceof Error ? error.message : String(error)),
            { cause: error }
        ));
        return undefined;
    }
}

function applyValidated(application, value, errors, onError) {
    for (const error of errors) {
        reportError(onError, new Error(error.key + ": " + error.message));
    }
    const keys = Object.keys(value);
    if (keys.length === 0) {
        return;
    }
    if (!application || application.supportsParameters !== true || typeof application.setParameters !== "function") {
        reportError(onError, new Error("application does not support setParameters for keys: " + keys.join(", ")));
        return;
    }
    invokeApplicationMethod(application, "setParameters", [value], onError);
}

/**
 * Create a host preference adapter for one application handle.
 *
 * Reads prefers-color-scheme, prefers-contrast, forced-colors, and
 * prefers-reduced-motion. Reads `--miniquad-foreground` /
 * `--miniquad-background` custom properties from `element`. Applies speed
 * and palette changes through `application.setParameters()`, and applies
 * reduced-motion by calling `application.pause()` / `application.resume()`.
 *
 * Motion handling:
 * - On creation, and on every "(prefers-reduced-motion: reduce)" change,
 *   the adapter calls pause() when the query matches and resume() otherwise,
 *   unless a motion override is active (see setMotionOverride()).
 * - `setMotionOverride("paused" | "running")` lets the host force a state
 *   regardless of the media query. `setMotionOverride("auto")` (the
 *   default) restores media-query-driven behavior.
 * - The adapter never calls pause()/resume() for the same target state
 *   twice in a row, so the host may safely call it from its own controls.
 *
 * `onError` is called for every unsupported command, invalid value,
 * invalid override, or a runtime exception thrown by
 * `application.pause()`, `application.resume()`, or
 * `application.setParameters()`. There is no silent fallback: a rejected
 * value, and a thrown runtime error, are never treated as a success. A
 * thrown call is caught only at that single call site; it does not widen
 * into a broad try/catch around adapter logic.
 *
 * `dispose()` removes every media-query listener added by this adapter. It
 * does not call application.dispose() or otherwise touch the application;
 * the host owns that lifecycle.
 *
 * @param {{element: Element, application: object, onError?: (error: Error) => void, view?: Window}} options
 */
export function createHostPreferences({ element, application, onError, view = typeof window !== "undefined" ? window : undefined } = {}) {
    if (!application || typeof application !== "object") {
        throw new TypeError("createHostPreferences requires an application handle");
    }
    const listeners = [];
    const subscribers = new Set();
    let motionOverride = "auto";
    let lastMotionRunning = null;
    let disposed = false;

    const media = readMediaState(view);
    const state = {
        colorScheme: media.colorScheme,
        contrast: media.contrast,
        forcedColors: media.forcedColors,
        reducedMotion: media.reducedMotion,
        motionOverride,
        lastErrors: []
    };

    function notify() {
        for (const subscriber of subscribers) {
            subscriber({ ...state });
        }
    }

    function applyMotion() {
        const shouldPause = motionOverride === "paused" || (motionOverride === "auto" && state.reducedMotion);
        const shouldRun = motionOverride === "running" || (motionOverride === "auto" && !state.reducedMotion);
        const running = shouldRun && !shouldPause;
        if (lastMotionRunning === running) {
            return;
        }
        lastMotionRunning = running;
        if (running) {
            if (typeof application.resume === "function") {
                invokeApplicationMethod(application, "resume", [], onError);
            } else {
                reportError(onError, new Error("application does not support resume()"));
            }
        } else if (typeof application.pause === "function") {
            invokeApplicationMethod(application, "pause", [], onError);
        } else {
            reportError(onError, new Error("application does not support pause()"));
        }
    }

    function applyPalette() {
        const { value, errors } = readPalette(element, view);
        applyValidated(application, value, errors, onError);
        if (errors.length > 0) {
            state.lastErrors = errors;
            notify();
        }
    }

    function watch(condition, onChange) {
        if (typeof view?.matchMedia !== "function") {
            return;
        }
        const list = view.matchMedia(condition);
        const handler = (event) => onChange(event.matches);
        if (typeof list.addEventListener === "function") {
            list.addEventListener("change", handler);
            listeners.push(() => list.removeEventListener("change", handler));
        } else if (typeof list.addListener === "function") {
            // Safari < 14 fallback; still cleaned up explicitly in dispose().
            list.addListener(handler);
            listeners.push(() => list.removeListener(handler));
        }
    }

    watch("(prefers-color-scheme: dark)", (matches) => {
        state.colorScheme = matches ? "dark" : "light";
        applyPalette();
        notify();
    });
    watch("(prefers-reduced-motion: reduce)", (matches) => {
        state.reducedMotion = matches;
        applyMotion();
        notify();
    });
    watch("(forced-colors: active)", (matches) => {
        state.forcedColors = matches;
        notify();
    });
    function recomputeContrast() {
        // `prefers-contrast` is a single enumerated media feature: exactly
        // one of no-preference/less/more/custom can match at a time. Each
        // underlying query is watched separately, so recompute the whole
        // value from scratch on every change (matching readMediaState's
        // own precedence order) instead of only ever setting a value on a
        // positive match - that one-directional update left state.contrast
        // stuck at "more"/"less"/"custom" even after the system preference
        // changed back to "no-preference".
        const query = (condition) => (typeof view?.matchMedia === "function" ? view.matchMedia(condition) : null);
        let contrast = "no-preference";
        if (query("(prefers-contrast: more)")?.matches) {
            contrast = "more";
        } else if (query("(prefers-contrast: less)")?.matches) {
            contrast = "less";
        } else if (query("(prefers-contrast: custom)")?.matches) {
            contrast = "custom";
        }
        if (state.contrast === contrast) {
            return;
        }
        state.contrast = contrast;
        // Contrast affects palette/theme selection only, never motion.
        notify();
    }
    watch("(prefers-contrast: more)", recomputeContrast);
    watch("(prefers-contrast: less)", recomputeContrast);
    watch("(prefers-contrast: custom)", recomputeContrast);

    applyMotion();
    applyPalette();

    return {
        getState() {
            return { ...state };
        },
        subscribe(listener) {
            if (typeof listener !== "function") {
                throw new TypeError("subscribe() requires a listener function");
            }
            subscribers.add(listener);
            return () => subscribers.delete(listener);
        },
        refreshPalette() {
            if (disposed) {
                throw new Error("cannot refreshPalette() after dispose()");
            }
            applyPalette();
        },
        setSpeed(value) {
            if (disposed) {
                throw new Error("cannot setSpeed() after dispose()");
            }
            const { value: validated, errors } = validateParameters({ speed: value });
            applyValidated(application, validated, errors, onError);
        },
        setMotionOverride(mode) {
            if (disposed) {
                throw new Error("cannot setMotionOverride() after dispose()");
            }
            if (!MOTION_OVERRIDES.includes(mode)) {
                reportError(onError, new TypeError("motion override must be one of " + MOTION_OVERRIDES.join(", ") + ", got " + String(mode)));
                return;
            }
            motionOverride = mode;
            state.motionOverride = mode;
            applyMotion();
            notify();
        },
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            for (const remove of listeners.splice(0)) {
                remove();
            }
            subscribers.clear();
        }
    };
}
