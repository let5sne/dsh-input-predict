import { createPredictor } from "./predictor.js";
// Invoke the public standard decorator API from plain JS. No generated artifacts.
function createRemoteService({ TypertRemoteService, Remote }) {
  const initializers = [];
  class InputPredictService extends TypertRemoteService {
    constructor(ctx, dependencies, config) {
      super(ctx, "inputPredict");
      for (const initialize of initializers) initialize.call(this);
      this.engine = createPredictor(dependencies, config);
      ctx.effect(() => () => this.engine.dispose());
    }
    config() {
      return this.engine.config();
    }
    snapshot(request, signal) {
      return this.engine.snapshot(request, this.callSignal(signal));
    }
    predict(request, signal) {
      return this.engine.predict(request, this.callSignal(signal));
    }
    callSignal(signal) {
      // Gateway unary signals follow HTTP cancellation; also bind API Peer disposal.
      const peerSignal = this.ctx.invocation?.peer.signal;
      return AbortSignal.any([signal, peerSignal].filter(Boolean));
    }
  }
  for (const name of ["snapshot", "predict", "config"]) {
    const decorator = name === "config" ? Remote("config") : Remote({ resources: { session: (request) => request.sessionId } });
    decorator(InputPredictService.prototype[name], { kind: "method", name, static: false, private: false, addInitializer(fn) {
      initializers.push(fn);
    } });
  }
  return InputPredictService;
}
export {
  createRemoteService
};
