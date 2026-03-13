# Changelog

## [1.0.0](https://github.com/emmanuel/durable-xstate/compare/durable-machine/v0.2.0...durable-machine/v1.0.0) (2026-03-13)


### ⚠ BREAKING CHANGES

* pre-GA API audit — make illegal states unrepresentable

### Features

* add analytics queries over transition_log and REST endpoints ([175a83d](https://github.com/emmanuel/durable-xstate/commit/175a83da722d29f536c8dc25a4c4eeabdc45c4ae))
* add batch send API for multi-target event dispatch ([f5c115e](https://github.com/emmanuel/durable-xstate/commit/f5c115e77c53ff99c0c0680412a05b34bec6e84c))
* add createPgWorkerContext() for PG-specific worker lifecycle ([bfa2195](https://github.com/emmanuel/durable-xstate/commit/bfa21956fc0a7c8a6f8bd0eebf9bce9bfe524fd7))
* add dependency-cruiser + FTA static analysis with architecture lint ([d5da9ee](https://github.com/emmanuel/durable-xstate/commit/d5da9ee1b236cb5015f701274a6fd91eab6b3b9e))
* add durableSetup() for schema-driven event and input forms ([2ca390a](https://github.com/emmanuel/durable-xstate/commit/2ca390a7845ee054fcc2f9427bd30af1ff0381d5))
* add first-class effects system for fire-and-forget side effects on state entry ([49dff38](https://github.com/emmanuel/durable-xstate/commit/49dff38d49e3eabf90a44ef758db2751df1a74ee))
* add machine-as-data definition module for JSON-driven machine creation ([56efd37](https://github.com/emmanuel/durable-xstate/commit/56efd376b7610feb9c01e0a5abf2146d086ce5cb))
* add metadata-driven start page, extended field schemas, and backend comparison docs ([e0fe567](https://github.com/emmanuel/durable-xstate/commit/e0fe5672baf29d0b7fdd1b8d9d10d6e084237003))
* add OTel store metrics, pg-stat benchmarks, PG example, and ESM fixes ([e28281e](https://github.com/emmanuel/durable-xstate/commit/e28281e9621f295925f889655e673de9f78ca3d0))
* add server-rendered dashboard for gateway ([0f39a7e](https://github.com/emmanuel/durable-xstate/commit/0f39a7e8175fc6695e52715cc346de2f712d52c0))
* add transactional outbox for durable effect execution ([5d11c6d](https://github.com/emmanuel/durable-xstate/commit/5d11c6d692c7c2506b2a796add4f03e052ed69d0))
* add useBatchProcessing toggle and before/after throughput benchmark ([e599ff3](https://github.com/emmanuel/durable-xstate/commit/e599ff3163b2f3cdda95b425597e5a31f2029e15))
* durableSetup schemas, graph labels, and timeline sort toggle ([3660bbb](https://github.com/emmanuel/durable-xstate/commit/3660bbb93f5df0207092572ef80c7d45f9328029))
* expose worker machines registry for dynamic REST API visibility ([e83f116](https://github.com/emmanuel/durable-xstate/commit/e83f116a1645fa577783036b5db8955502c73088))
* implement direct Postgres backend for durable state machines ([1f99390](https://github.com/emmanuel/durable-xstate/commit/1f99390efe460e31a5b26670839078ba95892892))
* integrate analytics into dashboard ELK graph with heat map and dwell-time sublabels ([ed68d2c](https://github.com/emmanuel/durable-xstate/commit/ed68d2cc30867676c4582badf9436416f7515082))
* pg throughput optimizations — batch drain, skip locked, adaptive polling ([f34078b](https://github.com/emmanuel/durable-xstate/commit/f34078bf1e68750760db89e2247a849ee9688d27))
* replace transient message queue with append-only event log ([9051fcb](https://github.com/emmanuel/durable-xstate/commit/9051fcb489d09558368a9b96257e4dcde1a67260))
* split transaction in processNextFromLog to avoid holding PG connection during invocation I/O ([eb0b67a](https://github.com/emmanuel/durable-xstate/commit/eb0b67add4347a5d4d4a7246396c210c1864ef4b))
* unified activity feed for dashboard instance detail ([dadc433](https://github.com/emmanuel/durable-xstate/commit/dadc433b503ab71d9cebb0cc82b1a8d1bdcef200))


### Bug Fixes

* close security hardening phases 2, 3, and 5 ([05d2549](https://github.com/emmanuel/durable-xstate/commit/05d254917dce313c39ac04cad5701c80bb0f01e1))
* comprehensive security hardening across gateway, durable-machine, and worker ([a148249](https://github.com/emmanuel/durable-xstate/commit/a1482494fad26c78b6967746355fd3a8de797cb3))
* replace SKIP LOCKED with blocking FOR NO KEY UPDATE in CTE queries ([0665bfa](https://github.com/emmanuel/durable-xstate/commit/0665bfa507ed7e96e87ecc44f8c30b657ac445a7))
* unify API inconsistencies across gateway & worker packages ([3d1ff3f](https://github.com/emmanuel/durable-xstate/commit/3d1ff3f999f1ce47346d3257d2c2cd3a8b86d18b))


### Refactors

* add query instrumentation to all store functions ([439663f](https://github.com/emmanuel/durable-xstate/commit/439663f32fd14f09b950c845d5b953113d474d31))
* add withTransaction to PgStore, simplify event-processor ([5bf32c1](https://github.com/emmanuel/durable-xstate/commit/5bf32c1635de784655f6bfb092e54453b55c4dcd))
* eliminate dynamic SQL with prepared statements ([570db27](https://github.com/emmanuel/durable-xstate/commit/570db279d7ec4c194a414c0fe5332d106b470ff8))
* extract app lifecycle into createAppContext, make machines pure DAOs ([a6c9318](https://github.com/emmanuel/durable-xstate/commit/a6c9318e5a7ca57d6d3adf17ff528b33888c0e36))
* extract backend-agnostic gateway & worker lifecycle ([f1e0336](https://github.com/emmanuel/durable-xstate/commit/f1e03368ae37027532254fb826d0bccf5b93304a))
* extract conformance test harness for backend-agnostic integration tests ([e04d8e9](https://github.com/emmanuel/durable-xstate/commit/e04d8e94698fd2e6f2fbe0f7f89f359b59371fd7))
* extract executeAndFinalizeInvocation from processBatchFromLog ([50210b3](https://github.com/emmanuel/durable-xstate/commit/50210b340d9a9647701c1b6b92f08651f2e714b5))
* extract PG queries to prepared statement objects ([efac825](https://github.com/emmanuel/durable-xstate/commit/efac8251bc5e4344299ebeaed6a92f7b71a87d89))
* pre-GA API audit — make illegal states unrepresentable ([fae29e0](https://github.com/emmanuel/durable-xstate/commit/fae29e00a0e7dbe7d74563ab563a71092aa53e91))
* ratchet FTA score cap to 70 and remove dependency diagrams ([d5fadf9](https://github.com/emmanuel/durable-xstate/commit/d5fadf919f924eadfcb1a1657e166583d43be605))
* rename @xstate-durable/machine to @xstate-durable/durable-machine ([8361ec2](https://github.com/emmanuel/durable-xstate/commit/8361ec209ce34fb6475d82431fe6e2b34b11f22a))
* rename npm scope from [@xstate-durable](https://github.com/xstate-durable) to [@durable-xstate](https://github.com/durable-xstate) ([8a6ae1f](https://github.com/emmanuel/durable-xstate/commit/8a6ae1fd71abe5bbb8593c4af580999d5725afdb))
* rename packages to @xstate-durable/* and separate DBOS backend into subpath ([10da358](https://github.com/emmanuel/durable-xstate/commit/10da3585a3a7b7b028e35254d396a410b5bd99a5))
* replace generic updateInstance with purpose-specific store methods ([6ccba31](https://github.com/emmanuel/durable-xstate/commit/6ccba31231a2b8ed68d641c123978b40ebfd86ba))


### Chores

* bump all packages to 0.2.0 ([938fb0f](https://github.com/emmanuel/durable-xstate/commit/938fb0f3ee269b51da08c7de3b4f6a8894d32d26))
* centralize test DB config, add CI/CD, and add recruiting-pipeline example ([1d109c2](https://github.com/emmanuel/durable-xstate/commit/1d109c25cb1999f9369a014f0d380501593c08bd))


### Docs

* add pg throughput optimization plan with benchmark results ([c5ecb39](https://github.com/emmanuel/durable-xstate/commit/c5ecb391f72a5687768ad54bec2ebeb30f6f140a))
