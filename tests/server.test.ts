import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createService, resolveBindAddress } from "../server.ts";

function canListen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

test("resolveBindAddress defaults to loopback and honors override", () => {
  assert.equal(resolveBindAddress(undefined), "127.0.0.1");
  assert.equal(resolveBindAddress("0.0.0.0"), "0.0.0.0");
});

test("service serves /api/health and releases the port on stop", async () => {
  const svc = await createService({ port: 0, bindAddress: "127.0.0.1", workers: false });
  assert.ok(svc.port > 0);
  const res = await fetch(`http://127.0.0.1:${svc.port}/api/health`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '{"status":"ok"}');
  await svc.stop();
  assert.equal(await canListen(svc.port), true);
});
