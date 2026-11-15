export function shouldIncludeHardwareGpuProject(browser, optIn) {
  return optIn === "1" && (!browser || browser === "chromium");
}
