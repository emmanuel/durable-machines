# Changelog

## [1.0.0](https://github.com/emmanuel/durable-xstate/compare/gateway/v0.2.0...gateway/v1.0.0) (2026-03-13)


### ⚠ BREAKING CHANGES

* pre-GA API audit — make illegal states unrepresentable

### Features

* add active sleep countdown for after delayed transitions ([5a5a4ae](https://github.com/emmanuel/durable-xstate/commit/5a5a4ae8ebd5dcd24331cc01a298ef8a61e7672a))
* add analytics queries over transition_log and REST endpoints ([175a83d](https://github.com/emmanuel/durable-xstate/commit/175a83da722d29f536c8dc25a4c4eeabdc45c4ae))
* add batch send API for multi-target event dispatch ([f5c115e](https://github.com/emmanuel/durable-xstate/commit/f5c115e77c53ff99c0c0680412a05b34bec6e84c))
* add cancel instance button to dashboard detail view ([a442575](https://github.com/emmanuel/durable-xstate/commit/a442575ddd7785bc82a25a0218a82b2a511630ee))
* add dependency-cruiser + FTA static analysis with architecture lint ([d5da9ee](https://github.com/emmanuel/durable-xstate/commit/d5da9ee1b236cb5015f701274a6fd91eab6b3b9e))
* add durableSetup() for schema-driven event and input forms ([2ca390a](https://github.com/emmanuel/durable-xstate/commit/2ca390a7845ee054fcc2f9427bd30af1ff0381d5))
* add error display panel to dashboard instance detail ([ef52a98](https://github.com/emmanuel/durable-xstate/commit/ef52a98f2f718e45a3be6a9d179bfc0681d83959))
* add metadata-driven start page, extended field schemas, and backend comparison docs ([e0fe567](https://github.com/emmanuel/durable-xstate/commit/e0fe5672baf29d0b7fdd1b8d9d10d6e084237003))
* add OTel store metrics, pg-stat benchmarks, PG example, and ESM fixes ([e28281e](https://github.com/emmanuel/durable-xstate/commit/e28281e9621f295925f889655e673de9f78ca3d0))
* add REST API with HATEOAS responses and integrate into gateway lifecycle ([706ba72](https://github.com/emmanuel/durable-xstate/commit/706ba72f6cc68cf92a0c191c6e9c3161c5058f45))
* add runtime metrics, logger, typed machines, and gateway shutdown integration ([8aa7ffb](https://github.com/emmanuel/durable-xstate/commit/8aa7ffbed0ea2d9697545bb47cec50459819d158))
* add server-rendered dashboard for gateway ([0f39a7e](https://github.com/emmanuel/durable-xstate/commit/0f39a7e8175fc6695e52715cc346de2f712d52c0))
* add start instance form to dashboard instance list ([886337f](https://github.com/emmanuel/durable-xstate/commit/886337f274067688b3a13cdaf040c6d7d7661356))
* durableSetup schemas, graph labels, and timeline sort toggle ([3660bbb](https://github.com/emmanuel/durable-xstate/commit/3660bbb93f5df0207092572ef80c7d45f9328029))
* expose worker machines registry for dynamic REST API visibility ([e83f116](https://github.com/emmanuel/durable-xstate/commit/e83f116a1645fa577783036b5db8955502c73088))
* integrate analytics into dashboard ELK graph with heat map and dwell-time sublabels ([ed68d2c](https://github.com/emmanuel/durable-xstate/commit/ed68d2cc30867676c4582badf9436416f7515082))
* replace transient message queue with append-only event log ([9051fcb](https://github.com/emmanuel/durable-xstate/commit/9051fcb489d09558368a9b96257e4dcde1a67260))
* unified activity feed for dashboard instance detail ([dadc433](https://github.com/emmanuel/durable-xstate/commit/dadc433b503ab71d9cebb0cc82b1a8d1bdcef200))


### Bug Fixes

* add CORS configuration and optional logger for genericSource ([52f1d16](https://github.com/emmanuel/durable-xstate/commit/52f1d166dcea329cc85fb2172fb87859f6dffd09))
* close security hardening phases 2, 3, and 5 ([05d2549](https://github.com/emmanuel/durable-xstate/commit/05d254917dce313c39ac04cad5701c80bb0f01e1))
* comprehensive security hardening across gateway, durable-machine, and worker ([a148249](https://github.com/emmanuel/durable-xstate/commit/a1482494fad26c78b6967746355fd3a8de797cb3))
* dashboard SSE connection leak, trailing-slash 404, and final-state highlight ([71a382e](https://github.com/emmanuel/durable-xstate/commit/71a382e4d1715f096361ba6372e3ca2b72d74070))
* remove legacy action-link mode and shorthand REST routes ([83b2c06](https://github.com/emmanuel/durable-xstate/commit/83b2c065beceb512cec6ca1423f8ba8b483c34b5))
* reorder dashboard SSE routes to prevent shadowing; add SSE integration tests ([548be48](https://github.com/emmanuel/durable-xstate/commit/548be48055deb193e21ce2e1ca0171b03f9e3d1f))
* unify API inconsistencies across gateway & worker packages ([3d1ff3f](https://github.com/emmanuel/durable-xstate/commit/3d1ff3f999f1ce47346d3257d2c2cd3a8b86d18b))


### Refactors

* extract backend-agnostic gateway & worker lifecycle ([f1e0336](https://github.com/emmanuel/durable-xstate/commit/f1e03368ae37027532254fb826d0bccf5b93304a))
* migrate dashboard routes to /machines/:machineId/instances/:instanceId structure ([d7a59c1](https://github.com/emmanuel/durable-xstate/commit/d7a59c1dcf118cb25f5083b2a4169e556e7f0716))
* pre-GA API audit — make illegal states unrepresentable ([fae29e0](https://github.com/emmanuel/durable-xstate/commit/fae29e00a0e7dbe7d74563ab563a71092aa53e91))
* ratchet FTA score cap to 70 and remove dependency diagrams ([d5fadf9](https://github.com/emmanuel/durable-xstate/commit/d5fadf919f924eadfcb1a1657e166583d43be605))
* rename @xstate-durable/machine to @xstate-durable/durable-machine ([8361ec2](https://github.com/emmanuel/durable-xstate/commit/8361ec209ce34fb6475d82431fe6e2b34b11f22a))
* rename gateway & worker lifecycle APIs to include DBOS prefix ([520ff74](https://github.com/emmanuel/durable-xstate/commit/520ff74f6273e68c244f4bdb3a566cf2dcc4de9f))
* rename npm scope from [@xstate-durable](https://github.com/xstate-durable) to [@durable-xstate](https://github.com/durable-xstate) ([8a6ae1f](https://github.com/emmanuel/durable-xstate/commit/8a6ae1fd71abe5bbb8593c4af580999d5725afdb))
* rename packages to @xstate-durable/* and separate DBOS backend into subpath ([10da358](https://github.com/emmanuel/durable-xstate/commit/10da3585a3a7b7b028e35254d396a410b5bd99a5))


### Chores

* bump all packages to 0.2.0 ([938fb0f](https://github.com/emmanuel/durable-xstate/commit/938fb0f3ee269b51da08c7de3b4f6a8894d32d26))
* centralize test DB config, add CI/CD, and add recruiting-pipeline example ([1d109c2](https://github.com/emmanuel/durable-xstate/commit/1d109c25cb1999f9369a014f0d380501593c08bd))


### Tests

* add dashboard unit tests and fix dead code in extractVisitedStates ([b558a54](https://github.com/emmanuel/durable-xstate/commit/b558a54ec392d9cf48444d3dd28d4a53eff454c7))
* add full end-to-end PG integration test for REST API ([c6aff9e](https://github.com/emmanuel/durable-xstate/commit/c6aff9e77a395ce76381867e17426511febb3338))
