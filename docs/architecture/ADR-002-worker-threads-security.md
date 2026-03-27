# ADR-002: Use worker_threads.Worker for Instrumented Code Execution (v1 Trust Model)

**Status**: Accepted
**Date**: 2026-03-27
**Deciders**: Architecture team

## Context

The S4 Runtime Executor must run user-owned instrumented JavaScript in a way that isolates the execution from the VS Code extension host process. The isolation requirement has two dimensions: stability (a crashing or hanging user function must not crash the extension) and security (user code must not be able to read extension secrets or manipulate extension state).

Two mechanisms were evaluated. **`worker_threads.Worker`** is Node.js's built-in module for spawning an in-process thread with a separate V8 isolate. Each Worker has its own heap, its own global object, and communicates with the parent only via `postMessage`. It provides full isolation of memory and globals between runs. The cold-start overhead is approximately 50ms, which fits within the 400ms S4 budget. **`vm.runInNewContext`** creates a V8 context with a supplied sandbox object but runs synchronously in the same thread. It has known escape vectors — a malicious script can break out of the `vm` sandbox via prototype-chain manipulation — and it does not provide async execution or a timeout mechanism without additional wrappers. The ~20ms overhead saving over Worker does not offset these limitations.

v1 of the extension is explicitly targeted at developer workstations where the user owns the code being analyzed. The threat model is not an adversarial user submitting code to a shared service; it is a developer who wants complexity annotations on their own functions. The meaningful security boundary in v1 is crash isolation and state isolation between successive analysis runs, not sandbox escape prevention.

## Decision

`worker_threads.Worker` is used to execute instrumented code in S4. A fresh Worker is created per save (see ADR-003), receives the instrumented JavaScript and input sets via `postMessage`, collects `{n, opCount}` pairs per function, and terminates. The Worker has access to the full Node.js API — this is the v1 trust model, explicitly documented in the spec.

`vm.runInNewContext` is rejected for v1 because its synchronous execution model would block the extension host thread during user code execution, it cannot enforce a wall-clock timeout without a subprocess, and its security guarantees are weaker than claimed. `vm.runInNewContext` is deferred to v2, where it will be re-evaluated as an additional sandboxing layer on top of Worker, once the user base and threat model are better understood.

## Consequences

### Positive
- Worker threads provide a true V8 isolate: separate heap, no shared globals, clean memory between runs
- A Worker that throws an unhandled exception or exceeds the 5s timeout can be `terminate()`d without affecting the extension host
- `postMessage` is the only communication channel, making the data contract between extension and Worker explicit and auditable
- The Worker model supports async execution and structured concurrency natively

### Negative
- Worker threads do not prevent malicious code from making network calls, spawning child processes, or reading the filesystem — user code runs with the full Node.js API
- The v1 security model is only suitable for developer workstations; it cannot be used in a multi-user or server-side deployment
- The 50ms cold-start cost per save is unavoidable under the fresh-worker model (see ADR-003 for the trade-off)

### Mitigations
- The v1 security boundary is explicitly documented in the spec and in the extension's README; users are not misled about sandbox strength
- v2 will add `vm.runInNewContext` as an inner sandbox layer within the Worker, addressing the most common escape vectors while retaining the crash-isolation benefits of Worker threads
- Worker pooling (ADR-003) is deferred to v1.1 as an opt-in flag; if cold-start becomes a user-reported problem, the pool can be introduced without changing the security model
