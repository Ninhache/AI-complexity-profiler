# ADR-003: Spawn a Fresh Worker on Every Save

**Status**: Accepted
**Date**: 2026-03-27
**Deciders**: Architecture team

## Context

The S4 Runtime Executor uses a `worker_threads.Worker` to run instrumented JavaScript. A design choice is required on the lifecycle of that Worker: should the extension maintain a long-lived Worker (or pool of Workers) that is reused across saves, or spawn a new Worker for each save event?

**Worker pooling** would amortize the ~50ms cold-start cost across multiple saves. A pool of N pre-warmed Workers would each be idle between saves, receive the next instrumentation job via `postMessage`, execute it, and return a result. This approach is common in high-throughput server workloads. However, it introduces significant complexity for a developer-facing extension: the pool requires a management layer (acquire/release, health checks), a reset protocol to clear any state the previous user code wrote into the Worker's global scope, and a mechanism to detect and replace a Worker that was left in a bad state (e.g., a timed-out run that couldn't be cleanly cancelled). State leakage between successive runs — where a prior function's side effects influence the next function's measurement — would be a silent correctness bug that is very hard to detect and reproduce.

**Fresh Worker per save** pays the ~50ms cold-start on every save. The Worker starts clean, runs one instrumentation job, and is terminated. There is no state to reset and no pool to manage. The correctness guarantee is unconditional: two consecutive saves cannot affect each other.

The S4 performance budget is 400ms for worker execution on a 50-line file. The 50ms cold-start is 12.5% of that budget and leaves 350ms for actual measurement, which is sufficient for the 7 input sizes at [10, 30, 100, 300, 1000, 3000, 10000].

## Decision

A fresh Worker is spawned on every save event. The Worker is created with `new Worker(instrumentedJs, { eval: true })`, receives input sets via `postMessage`, runs all measurements, and is terminated via `worker.terminate()` or natural completion. No worker pool is maintained in v1.

Worker pooling is explicitly deferred to v1.1 as an opt-in configuration flag (`tsComplexity.workerPoolSize`). It will be implemented only after user feedback confirms that the 50ms cold-start is perceptible and unacceptable, and after the pool reset protocol is fully specified and tested.

## Consequences

### Positive
- Zero state leakage between saves: each Worker starts with a clean V8 isolate
- No pool management code: no acquire/release, no health checks, no reset protocol
- Correctness is unconditional: a crashing or misbehaving save cannot affect subsequent saves
- Implementation is simpler; the Worker lifecycle is a single create-run-terminate sequence
- Easier to test: each test case gets a guaranteed-fresh execution environment

### Negative
- ~50ms cold-start cost on every save, even for files where the complexity results have not changed
- On a very fast typist who saves frequently, Workers may be created and immediately cancelled if a new save arrives before the previous analysis completes
- No opportunity to cache compiled Worker scripts or pre-initialize the Node.js module loader

### Mitigations
- The 50ms cold-start is within the 400ms S4 budget for the primary use case (50-line files); the end-to-end target of 800ms is still achievable
- Rapid save cancellation is handled by tracking the current analysis token: a new save cancels the previous Worker via `worker.terminate()` before starting a new one, preventing resource accumulation
- Worker pooling is on the v1.1 roadmap with a feature flag; users who find the cold-start unacceptable can opt in to the pool once it is implemented and validated
