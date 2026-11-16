import test from "node:test";
import assert from "node:assert/strict";
const load = () => import("../host/predictor.js");
const req = (extra = {}) => ({ sessionId: "s1", requestId: "r1", draftRev: 3, mode: "suffix", draft: "hello", ...extra });
function fixture(stream, config = {}) {
  const messages = [{ role: "user", content: [{ type: "text", text: "visible" }, { type: "reasoning", text: "secret" }] }, { role: "system", content: [{ type: "text", text: "hidden" }] }];
  const session = { surface: { nodes: [1, 2], contentGeneration: 1, replaceGeneration: 0 }, deriveMessages: () => messages };
  let calls = 0;
  let options;
  const deps = { sessionQuery: { inspectSession: async (id, getter) => {
    const result = getter(session);
    assert.equal(typeof result?.then, "undefined");
    return result;
  } }, agentDefaultModel: { currentSelection: () => ({ provider: "p", model: "m", reasoningEffort: "high" }) }, llm: { stream(o) {
    calls++;
    options = o;
    return stream(o);
  } } };
  return { deps, config, session, messages, get calls() {
    return calls;
  }, get options() {
    return options;
  } };
}
async function* good() {
  yield { type: "text-delta", text: '{"text":" world"}' };
  yield { type: "finish", reason: { kind: "stop" } };
}
async function setup(stream = good, config = {}) {
  const { createPredictor } = await load();
  const f = fixture(stream, config);
  f.engine = createPredictor(f.deps, config);
  f.version = (await f.engine.snapshot(req())).contextVersion;
  return f;
}
test("snapshot detaches visible messages and preserves versions; suffix preserves leading space", async () => {
  const f = await setup();
  const out = await f.engine.predict(req({ contextVersion: f.version }));
  assert.equal(out.text, " world");
  assert.equal(out.requestId, "r1");
  assert.equal(out.draftRev, 3);
  assert.equal(out.sessionId, "s1");
  assert.equal(out.contextVersion, f.version);
  assert.equal(f.options.maxTokens, 256);
  assert.equal(f.options.provider, "p");
  assert.equal(f.options.reasoningEffort, void 0);
  const prompt = JSON.stringify(f.options.messages);
  assert.match(prompt, /visible/);
  assert.doesNotMatch(prompt, /secret|hidden/);
  await f.engine.dispose();
});
test("rejects stale context before and after stream", async () => {
  const f = await setup();
  assert.equal((await f.engine.predict(req({ contextVersion: "old" }))).error.code, "stale-context");
  assert.equal(f.calls, 0);
  f.deps.llm.stream = async function* () {
    f.session.surface.contentGeneration++;
    yield* good();
  };
  assert.equal((await f.engine.predict(req({ contextVersion: f.version }))).error.code, "stale-context");
  await f.engine.dispose();
});
test("only normal stop and exact bounded JSON text are accepted", async () => {
  for (const [raw, finish] of [['{"text":"x"}', "max-tokens"], ["plain", "stop"], ['{"text":4}', "stop"], ['{"text":"x","extra":1}', "stop"], [JSON.stringify({ text: "x".repeat(601) }), "stop"]]) {
    const f2 = await setup(async function* () {
      yield { type: "text-delta", text: raw };
      yield { type: "finish", reason: { kind: finish } };
    });
    assert.equal((await f2.engine.predict(req({ contextVersion: f2.version }))).ok, false);
    await f2.engine.dispose();
  }
  const f = await setup(async function* () {
    yield { type: "text-delta", text: '{"text":""}' };
    yield { type: "finish", reason: { kind: "stop" } };
  });
  assert.equal((await f.engine.predict(req({ contextVersion: f.version }))).text, "");
  await f.engine.dispose();
});
test("draft, mode and identity validation prevents model calls", async () => {
  const f = await setup();
  for (const invalid of [{ draft: "x".repeat(6001) }, { mode: "bad" }, { requestId: "" }, { draftRev: -1 }, { sessionId: "" }]) {
    assert.equal((await f.engine.predict(req({ contextVersion: f.version, ...invalid }))).ok, false);
  }
  assert.equal(f.calls, 0);
  await f.engine.dispose();
});
function constant(text) {
  return async function* () {
    yield { type: "text-delta", text: JSON.stringify({ text }) };
    yield { type: "finish", reason: { kind: "stop" } };
  };
}
test("prompt labels the last turns and asks for the user's following input", async () => {
  const f = await setup();
  f.messages.splice(0, 2,
    { role: "user", content: [{ type: "text", text: "请检查测试失败原因" }] },
    { role: "assistant", content: [{ type: "text", text: "已经修复，测试全部通过。" }] });
  f.version = (await f.engine.snapshot(req())).contextVersion;
  await f.engine.predict(req({ draft: "", mode: "next", contextVersion: f.version }));
  const data = JSON.parse(f.options.messages[0].content[0].text);
  assert.equal(data.lastUserMessage, "请检查测试失败原因");
  assert.equal(data.lastAssistantMessage, "已经修复，测试全部通过。");
  assert.match(f.options.system, /after the latest assistant reply/i);
  assert.match(f.options.system, /never repeat or paraphrase lastUserMessage/i);
  await f.engine.dispose();
});
test("candidates repeating or closely paraphrasing the last user message become empty", async () => {
  const last = "已按步骤复测，确认输入预测已开启、助手已停止，光标在文字末尾，等了几秒还是没有建议。请直接读取当前诊断和日志。";
  for (const candidate of [
    last,
    `${last}继续排查。`,
    "确认输入预测已开启、助手已停止，光标在文字末尾，等了几秒还是没有建议，请直接读取当前诊断。",
  ]) {
    const f = await setup(constant(candidate));
    f.messages.splice(0, 2, { role: "user", content: [{ type: "text", text: last }] },
      { role: "assistant", content: [{ type: "text", text: "诊断显示没有发出请求。" }] });
    f.version = (await f.engine.snapshot(req())).contextVersion;
    const out = await f.engine.predict(req({ draft: "", mode: "next", contextVersion: f.version }));
    assert.equal(out.ok, true);
    assert.equal(out.text, "", candidate);
    await f.engine.dispose();
  }
});
test("prompt lists earlier user messages as already handled and grounds on the latest reply", async () => {
  const f = await setup();
  const users = ["一", "二", "三", "四", "五", "六", "七"].map((n) => `第${n}个问题：输入框里没有显示预测内容`);
  f.messages.splice(0, 2, ...users.flatMap((text) => [
    { role: "user", content: [{ type: "text", text }] },
    { role: "assistant", content: [{ type: "text", text: "已修复。" }] },
  ]), { role: "user", content: [{ type: "text", text: "按建议修改" }] },
  { role: "assistant", content: [{ type: "text", text: "已完成修改，需要我继续调整颜色吗？" }] });
  f.version = (await f.engine.snapshot(req())).contextVersion;
  await f.engine.predict(req({ draft: "", mode: "next", contextVersion: f.version }));
  const data = JSON.parse(f.options.messages[0].content[0].text);
  assert.equal(data.earlierUserMessages.length, 6, "the six most recent user messages");
  assert.equal(data.earlierUserMessages.at(-1), "按建议修改");
  assert.equal(data.lastAssistantMessage, "已完成修改，需要我继续调整颜色吗？");
  assert.match(f.options.system, /earlierUserMessages/);
  assert.match(f.options.system, /already (been )?(handled|addressed)/i);
  assert.match(f.options.system, /do not (raise|re-raise|bring up)/i);
  await f.engine.dispose();
});
test("restatements of any of the last six user messages are filtered", async () => {
  const old = "请检查一下为什么提示条没有和输入框对齐，左右两边都超出了";
  const f = await setup(constant("请检查一下为什么提示条没有和输入框对齐，左右两边都超出了。"));
  f.messages.splice(0, 2,
    { role: "user", content: [{ type: "text", text: old }] },
    ...["a", "b", "c", "d"].flatMap((n) => [
      { role: "assistant", content: [{ type: "text", text: "好的。" }] },
      { role: "user", content: [{ type: "text", text: `中间的另一个请求 ${n}，内容完全不同` }] },
    ]),
    { role: "assistant", content: [{ type: "text", text: "已经全部完成。" }] });
  f.version = (await f.engine.snapshot(req())).contextVersion;
  const out = await f.engine.predict(req({ draft: "", mode: "next", contextVersion: f.version }));
  assert.equal(out.text, "", "the fifth-latest user message is still in range");
  await f.engine.dispose();
});
test("short distinct follow-ups survive duplicate filtering", async () => {
  const f = await setup(constant("可以，继续优化候选质量并对齐提示条宽度。"));
  f.messages.splice(0, 2, { role: "user", content: [{ type: "text", text: "请看看为什么没有效果" }] },
    { role: "assistant", content: [{ type: "text", text: "已经修复，现在可以继续改进候选质量。" }] });
  f.version = (await f.engine.snapshot(req())).contextVersion;
  const out = await f.engine.predict(req({ draft: "", mode: "next", contextVersion: f.version }));
  assert.equal(out.text, "可以，继续优化候选质量并对齐提示条宽度。");
  await f.engine.dispose();
});
test("suffix candidates repeating the draft or the previous user message become empty", async () => {
  for (const [draft, candidate] of [["继续优化", "继续优化"], ["继续", "优化预测质量，避免复述上一条消息"]]) {
    const f = await setup(constant(candidate));
    f.messages.splice(0, 2, { role: "user", content: [{ type: "text", text: "继续优化预测质量，避免复述上一条消息" }] },
      { role: "assistant", content: [{ type: "text", text: "好的。" }] });
    f.version = (await f.engine.snapshot(req())).contextVersion;
    const out = await f.engine.predict(req({ draft, mode: "suffix", contextVersion: f.version }));
    assert.equal(out.text, "", `${draft} + ${candidate}`);
    await f.engine.dispose();
  }
});
test("config reports the loaded Host build without exposing model settings", async () => {
  const { createPredictor, HOST_BUILD } = await load();
  const f = fixture(good);
  const engine = createPredictor(f.deps, { provider: "secret-provider", model: "secret-model" });
  const config = engine.config();
  assert.equal(typeof HOST_BUILD, "string");
  assert.equal(config.build, HOST_BUILD);
  assert.doesNotMatch(JSON.stringify(config), /secret-provider|secret-model/);
  await engine.dispose();
});
test("context budgets keep latest 12 text messages within 12000 chars", async () => {
  const f = await setup();
  f.messages.splice(0, 2, ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: String(i).padStart(3, "0") + "x".repeat(1997) }] })));
  f.version = (await f.engine.snapshot(req())).contextVersion;
  await f.engine.predict(req({ contextVersion: f.version }));
  const data = JSON.parse(f.options.messages[0].content[0].text);
  assert.ok(data.history.length <= 12);
  assert.ok(data.history.reduce((n, m) => n + m.text.length, 0) <= 12e3);
  assert.match(data.history.at(-1).text, /019/);
  await f.engine.dispose();
});
test("rate limits each session and uses independent configured model", async () => {
  const f = await setup(good, { provider: "custom", model: "tiny" });
  assert.equal((await f.engine.predict(req({ contextVersion: f.version }))).ok, true);
  assert.equal((await f.engine.predict(req({ contextVersion: f.version }))).error.code, "rate-limited");
  assert.equal(f.options.provider, "custom");
  assert.equal(f.options.model, "tiny");
  await f.engine.dispose();
});
test("timeout, caller abort, and unload cancel even an uncooperative iterator", async () => {
  for (const mode of ["timeout", "abort", "dispose"]) {
    let observed;
    const f = await setup((o) => {
      observed = o.signal;
      return { [Symbol.asyncIterator]() {
        return this;
      }, next: () => new Promise(() => {
      }), return: () => Promise.resolve({ done: true }) };
    }, { timeoutMs: 20 });
    const c = new AbortController();
    const pending = f.engine.predict(req({ contextVersion: f.version }), c.signal);
    await new Promise((r) => setTimeout(r, 2));
    if (mode === "abort") c.abort();
    if (mode === "dispose") await f.engine.dispose();
    const result = await pending;
    assert.equal(result.ok, false);
    assert.equal(observed.aborted, true);
    await f.engine.dispose();
  }
});
test("simultaneous calls for one session reserve the rate gate before async inspection", async () => {
  const f = await setup(good, { maxConcurrent: 10 });
  const input = req({ contextVersion: f.version });
  const results = await Promise.all([f.engine.predict(input), f.engine.predict(input)]);
  assert.equal(f.calls, 1);
  assert.equal(results.filter((r) => r.ok).length, 1);
  await f.engine.dispose();
});
test("disabled configuration and unmatched model pair fail closed", async () => {
  const { createPredictor } = await load();
  const f = await setup(good, { enabled: false });
  assert.equal((await f.engine.predict(req({ contextVersion: f.version }))).error.code, "disabled");
  assert.equal(f.calls, 0);
  assert.throws(() => createPredictor(f.deps, { provider: "solo" }));
  assert.throws(() => createPredictor(f.deps, { timeoutMs: 0 }));
  await f.engine.dispose();
});
test("missing finish and tool output fail closed, next accepts a full draft", async () => {
  for (const chunks of [[{ type: "text-delta", text: '{"text":"x"}' }], [{ type: "tool-call-delta", argumentsDelta: "{}" }, { type: "finish", reason: { kind: "stop" } }]]) {
    const f2 = await setup(async function* () {
      yield* chunks;
    });
    assert.equal((await f2.engine.predict(req({ contextVersion: f2.version }))).ok, false);
    await f2.engine.dispose();
  }
  const f = await setup();
  assert.equal((await f.engine.predict(req({ draft: "", mode: "next", contextVersion: f.version }))).text, " world");
  await f.engine.dispose();
});
test("snapshot is disabled without reading and times out slow preparation", { timeout: 200 }, async () => {
  const { createPredictor } = await load();
  let reads = 0;
  const deps = { sessionQuery: { inspectSession() {
    reads++;
    return new Promise(() => {
    });
  } } };
  const off = createPredictor(deps, { enabled: false });
  assert.equal((await off.snapshot(req())).error.code, "disabled");
  assert.equal(reads, 0);
  await off.dispose();
  const slow = createPredictor(deps, { timeoutMs: 10 });
  assert.equal((await slow.snapshot(req())).error.code, "timeout");
  await slow.dispose();
});
test("explicit reasoning effort is optional and never inherited", async () => {
  const f = await setup(good, { reasoningEffort: "low" });
  await f.engine.predict(req({ contextVersion: f.version }));
  assert.equal(f.options.reasoningEffort, "low");
  await f.engine.dispose();
});
test("global concurrent cap is enforced", async () => {
  const f = await setup(() => ({ [Symbol.asyncIterator]() {
    return this;
  }, next: () => new Promise(() => {
  }), return: async () => ({ done: true }) }), { timeoutMs: 1e3 });
  const c = new AbortController();
  const a = f.engine.predict(req({ contextVersion: f.version }), c.signal);
  const b = f.engine.predict(req({ sessionId: "s2", contextVersion: f.version }), c.signal);
  await new Promise((r) => setTimeout(r, 2));
  assert.equal((await f.engine.predict(req({ sessionId: "s3", contextVersion: f.version }))).error.code, "busy");
  c.abort();
  await Promise.all([a, b]);
  await f.engine.dispose();
});
