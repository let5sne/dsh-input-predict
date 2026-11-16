import * as protocol from "@deepseek-ai/dsh-typert-protocol";
import Schema from "@deepseek-ai/schemastery";
import { createRemoteService } from "./host/remote.js";
import { DEFAULTS, resolveConfig } from "./host/predictor.js";
const inject = ["llm", "sessionQuery", "agentDefaultModel", "typertGateway"];
const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled),
  provider: Schema.string(),
  model: Schema.string(),
  reasoningEffort: Schema.string(),
  ...Object.fromEntries(Object.entries(DEFAULTS).filter(([key]) => key !== "enabled").map(([key, value]) => [
    key,
    Schema.number().step(1).min(key === "minIntervalMs" ? 0 : 1).max(2147483647).default(value)
  ]))
});
const InputPredictService = createRemoteService(protocol);
function apply(ctx, config) {
  const resolved = resolveConfig(config);
  ctx.plugin({ name: "input-predict-runtime", apply(owner) {
    new InputPredictService(owner, { llm: owner.llm, sessionQuery: owner.sessionQuery, agentDefaultModel: owner.agentDefaultModel }, resolved);
  } });
}
export {
  Config,
  apply,
  inject
};
