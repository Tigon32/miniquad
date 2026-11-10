import { test, expect } from "@playwright/test";

test("browser epoch clock is finite and nondecreasing under active timer precision",async({page},testInfo)=>{
  const errors=[];
  page.on("pageerror",error=>errors.push(error.message));
  await page.goto("/clock-privacy",{waitUntil:"load"});
  const samples=await page.evaluate(async()=>{
    if(typeof importObject?.env?.now!=="function")throw Error("Missing bridge clock import");
    const now=importObject.env.now;
    const first=[];
    for(let i=0;i<150;i++)first.push(now());
    await new Promise(resolve=>setTimeout(resolve,250));
    const second=[];
    for(let i=0;i<150;i++)second.push(now());
    return {
      sampled:[...first,...second],
      clockSource:typeof performance?.now,
      epoch:Date.now()/1000,
      highResReference:performance.timeOrigin+performance.now(),
      filename:"clock-privacy"
    };
  });
  expect(samples.sampled.length).toBe(300);
  expect(samples.clockSource).toBe("function");
  for(let i=0;i<samples.sampled.length;i++){
    expect(Number.isFinite(samples.sampled[i])).toBe(true);
    if(i>0)expect(samples.sampled[i]).toBeGreaterThanOrEqual(samples.sampled[i-1]);
  }
  expect(Math.abs(samples.sampled.at(-1)-samples.epoch)).toBeLessThan(5);
  expect(samples.sampled.at(-1)).toBeGreaterThan(samples.sampled[0]);
  expect(errors).toEqual([]);
  await testInfo.attach("clock-privacy-evidence.json",{
    contentType:"application/json",
    body:JSON.stringify({
      browser:testInfo.project.name,
      firefoxPrivacyPrefsEnabled:process.env.MINIQUAD_FIREFOX_PRIVACY==="1",
      sourceHead:process.env.GITHUB_HEAD_SHA||process.env.GITHUB_SHA||"local",
      sampleCount:samples.sampled.length,
      start:samples.sampled[0],end:samples.sampled.at(-1),
      uniqueValues:new Set(samples.sampled).size,
      epochDifferenceSeconds:samples.sampled.at(-1)-samples.epoch,
      privacyNote:"Firefox privacy preferences belong to Playwright launch configuration, not to JavaScript itself."
    },null,2)
  });
});
