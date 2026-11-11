// Page instrumentation for the WebGPU proof harness.
// Playwright serializes `instrument` with addInitScript, so it must not use outer names.
// Candidates must not depend on this code. It only records facts and applies one injection.

export const INJECTIONS = Object.freeze({
    N1: "no-api",
    N2: "insecure",
    N3: "no-adapter",
    N4: "device-reject",
});

export function instrument(options) {
    const inject = options && options.inject ? options.inject : null;
    const g = globalThis;
    const record = {
        inject: inject,
        contexts: [],
        adapterRequests: 0,
        adapters: [],
        deviceRequests: 0,
        devices: 0,
        validationErrors: [],
        rejections: [],
        errors: [],
    };
    const devices = [];
    Object.defineProperty(g, "__mqProofRecord", {value: record, configurable: false});
    Object.defineProperty(g, "__mqProofDevices", {value: devices, configurable: false});

    const text = value => {
        try {
            if (value && typeof value === "object" && "message" in value) return String(value.message);
            return String(value);
        } catch {
            return "unprintable";
        }
    };
    if (typeof g.addEventListener === "function") {
        g.addEventListener("unhandledrejection", event => record.rejections.push(text(event.reason)));
        g.addEventListener("error", event => record.errors.push(text(event.error || event.message)));
    }

    const wrapContext = proto => {
        if (!proto || typeof proto.getContext !== "function") return;
        const original = proto.getContext;
        proto.getContext = function (type, ...rest) {
            record.contexts.push(String(type));
            return original.call(this, type, ...rest);
        };
    };
    if (typeof g.HTMLCanvasElement === "function") wrapContext(g.HTMLCanvasElement.prototype);
    if (typeof g.OffscreenCanvas === "function") wrapContext(g.OffscreenCanvas.prototype);

    if (inject === "no-api" && typeof g.Navigator === "function") {
        delete g.Navigator.prototype.gpu;
        if (g.navigator && "gpu" in g.navigator) {
            Object.defineProperty(g.Navigator.prototype, "gpu", {get: () => undefined, configurable: true});
        }
    }
    if (inject === "insecure") {
        Object.defineProperty(g, "isSecureContext", {get: () => false, configurable: true});
    }

    const adapterFacts = adapter => {
        const info = adapter.info || {};
        const fallback = typeof info.isFallbackAdapter === "boolean" ? info.isFallbackAdapter
            : typeof adapter.isFallbackAdapter === "boolean" ? adapter.isFallbackAdapter : null;
        return {
            vendor: String(info.vendor || ""),
            architecture: String(info.architecture || ""),
            device: String(info.device || ""),
            description: String(info.description || ""),
            isFallbackAdapter: fallback,
        };
    };

    if (typeof g.GPU === "function" && typeof g.GPU.prototype.requestAdapter === "function") {
        const requestAdapter = g.GPU.prototype.requestAdapter;
        g.GPU.prototype.requestAdapter = function (...args) {
            record.adapterRequests += 1;
            if (inject === "no-adapter") {
                record.adapters.push(null);
                return Promise.resolve(null);
            }
            return requestAdapter.apply(this, args).then(adapter => {
                record.adapters.push(adapter ? adapterFacts(adapter) : null);
                return adapter;
            });
        };
    }
    if (typeof g.GPUAdapter === "function" && typeof g.GPUAdapter.prototype.requestDevice === "function") {
        const requestDevice = g.GPUAdapter.prototype.requestDevice;
        g.GPUAdapter.prototype.requestDevice = function (...args) {
            record.deviceRequests += 1;
            if (inject === "device-reject") {
                const Failure = typeof g.DOMException === "function" ? g.DOMException : Error;
                return Promise.reject(new Failure("Injected device request failure", "OperationError"));
            }
            return requestDevice.apply(this, args).then(device => {
                devices.push(device);
                record.devices = devices.length;
                device.addEventListener("uncapturederror", event => {
                    const error = event.error || {};
                    record.validationErrors.push({
                        type: error.constructor ? error.constructor.name : "unknown",
                        message: text(error),
                    });
                });
                return device;
            });
        };
    }
}
