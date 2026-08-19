import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${pathname}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("redirects the root route to the default Chinese locale", async () => {
  const response = await render("/");
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "/zh");
});

for (const locale of ["zh", "en"]) {
  test(`server-renders the ${locale} anatomy application`, async () => {
    const response = await render(`/${locale}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    const html = await response.text();
    assert.match(html, new RegExp(`<html lang="${locale}"`));
    assert.match(html, /Anatomy Atelier/);
    assert.match(
      html,
      locale === "zh" ? /像艺术家一样学解剖/ : /Learn anatomy like an artist/,
    );
    assert.doesNotMatch(html, /Your site is taking shape|Building your site/);
  });
}
