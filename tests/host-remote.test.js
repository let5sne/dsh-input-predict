import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const installed = process.env.DSH_INSTALL_DIR;
const child = process.env.INPUT_PREDICT_RUNTIME_TEST === "1";
test("installed Gateway enforces Session resource authorization for plain JS Remote", { skip: !installed }, async () => {
  if (!child) {
    const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: "1", INPUT_PREDICT_RUNTIME_TEST: "1" };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(process.env.DSH_NODE_EXECUTABLE, ["--test", import.meta.filename], { encoding: "utf8", env: childEnv });
    assert.equal(result.status, 0, result.stdout + "\n" + result.stderr);
    return;
  }
  const require2 = createRequire(installed + "/package.json");
  const load = (name) => import(pathToFileURL(require2.resolve(name)).href);
  const { Context, Service } = await load("@deepseek-ai/cordis");
  const protocol = await load("@deepseek-ai/dsh-typert-protocol");
  const registry = await load("@deepseek-ai/dsh-typert-registry");
  const { TypertGatewayService } = await load("@deepseek-ai/dsh-api-gateway");
  const { createRemoteService } = await import("../host/remote.js");
  const ctx = new Context();
  new registry.TypertRegistry(ctx);
  let decisions = [];
  let reads = 0;
  let calls = 0;
  new class extends Service {
    constructor() {
      super(ctx, "remoteAccess");
    }
    decide(input) {
      decisions.push(input);
      return { kind: "deny", reason: "test-deny" };
    }
  }();
  const gateway = new TypertGatewayService(ctx, {});
  const Remote = createRemoteService(protocol);
  const service = new Remote(ctx, { sessionQuery: { inspectSession: async (id, get) => {
    reads++;
    return get({ surface: { nodes: [], contentGeneration: 0, replaceGeneration: 0 }, deriveMessages: () => [] });
  } }, llm: { stream() {
    calls++;
    throw Error("never");
  } }, agentDefaultModel: { currentSelection: () => ({ provider: "mock", model: "mock" }) } }, {});
  const owner = { id: "owner", ctx, principal: { kind: "owner" }, signal: new AbortController().signal, interactions: "answer" };
  const guest = { ...owner, id: "guest", principal: { kind: "guest" } };
  const request = { sessionId: "s1", requestId: "r1", draftRev: 1 };
  const value = await gateway.invoke({ namespace: "inputPredict", method: "snapshot", args: { request }, peer: owner });
  assert.equal(value.ok, true);
  assert.equal(reads, 1);
  await assert.rejects(gateway.invoke({ namespace: "inputPredict", method: "snapshot", args: { request }, peer: guest }), (e) => e.code === "remote-access/denied");
  assert.equal(reads, 1);
  assert.deepEqual(decisions[0].resources, [{ kind: "session", id: "s1" }]);
  await assert.rejects(gateway.invoke({ namespace: "inputPredict", method: "predict", args: { request: { ...request, draft: "", mode: "next", contextVersion: value.contextVersion } }, peer: guest }), (e) => e.code === "remote-access/denied");
  assert.equal(calls, 0);
  assert.equal((await gateway.invoke({ namespace: "inputPredict", method: "config", args: {}, peer: owner })).debounceMs, 900);
  let streamSignal;
  service.engine.dispose();
  const { createPredictor } = await import("../host/predictor.js");
  service.engine = createPredictor({ sessionQuery: { inspectSession: async (id, get) => get({ surface: { nodes: [], contentGeneration: 0, replaceGeneration: 0 }, deriveMessages: () => [] }) }, agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m" }) }, llm: { stream(options) {
    streamSignal = options.signal;
    return { [Symbol.asyncIterator]() {
      return this;
    }, next: () => new Promise(() => {
    }), return: async () => ({ done: true }) };
  } } }, { timeoutMs: 50 });
  const peerAbort = new AbortController();
  const pending = gateway.invoke({ namespace: "inputPredict", method: "predict", args: { request: { ...request, draft: "", mode: "next", contextVersion: value.contextVersion } }, peer: { ...owner, signal: peerAbort.signal } });
  await new Promise((r) => setTimeout(r, 2));
  peerAbort.abort();
  await new Promise((r) => setTimeout(r, 2));
  assert.equal(streamSignal.aborted, true, "peer disposal must cancel the model immediately");
  await pending;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(gateway.invoke({ namespace: "inputPredict", method: "snapshot", args: { request }, peer: { ...owner, signal: controller.signal } }), (e) => e.code === "gateway/peer-disposed");
  await service.engine.dispose();
});
