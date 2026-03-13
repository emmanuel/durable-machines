# Changelog

## [1.0.0](https://github.com/emmanuel/durable-xstate/compare/worker/v0.2.0...worker/v1.0.0) (2026-03-13)


### ⚠ BREAKING CHANGES

* pre-GA API audit — make illegal states unrepresentable

### Features

* add dependency-cruiser + FTA static analysis with architecture lint ([d5da9ee](https://github.com/emmanuel/durable-xstate/commit/d5da9ee1b236cb5015f701274a6fd91eab6b3b9e))
* add OTel store metrics, pg-stat benchmarks, PG example, and ESM fixes ([e28281e](https://github.com/emmanuel/durable-xstate/commit/e28281e9621f295925f889655e673de9f78ca3d0))
* add runtime metrics, logger, typed machines, and gateway shutdown integration ([8aa7ffb](https://github.com/emmanuel/durable-xstate/commit/8aa7ffbed0ea2d9697545bb47cec50459819d158))
* add worker package with startup metrics and add package READMEs ([56fe3a6](https://github.com/emmanuel/durable-xstate/commit/56fe3a615fc904ef11d3f789b0031520d582c29a))


### Bug Fixes

* comprehensive security hardening across gateway, durable-machine, and worker ([a148249](https://github.com/emmanuel/durable-xstate/commit/a1482494fad26c78b6967746355fd3a8de797cb3))
* unify API inconsistencies across gateway & worker packages ([3d1ff3f](https://github.com/emmanuel/durable-xstate/commit/3d1ff3f999f1ce47346d3257d2c2cd3a8b86d18b))


### Refactors

* extract backend-agnostic gateway & worker lifecycle ([f1e0336](https://github.com/emmanuel/durable-xstate/commit/f1e03368ae37027532254fb826d0bccf5b93304a))
* pre-GA API audit — make illegal states unrepresentable ([fae29e0](https://github.com/emmanuel/durable-xstate/commit/fae29e00a0e7dbe7d74563ab563a71092aa53e91))
* ratchet FTA score cap to 70 and remove dependency diagrams ([d5fadf9](https://github.com/emmanuel/durable-xstate/commit/d5fadf919f924eadfcb1a1657e166583d43be605))
* rename @xstate-durable/machine to @xstate-durable/durable-machine ([8361ec2](https://github.com/emmanuel/durable-xstate/commit/8361ec209ce34fb6475d82431fe6e2b34b11f22a))
* rename gateway & worker lifecycle APIs to include DBOS prefix ([520ff74](https://github.com/emmanuel/durable-xstate/commit/520ff74f6273e68c244f4bdb3a566cf2dcc4de9f))
* rename npm scope from [@xstate-durable](https://github.com/xstate-durable) to [@durable-xstate](https://github.com/durable-xstate) ([8a6ae1f](https://github.com/emmanuel/durable-xstate/commit/8a6ae1fd71abe5bbb8593c4af580999d5725afdb))
* rename packages to @xstate-durable/* and separate DBOS backend into subpath ([10da358](https://github.com/emmanuel/durable-xstate/commit/10da3585a3a7b7b028e35254d396a410b5bd99a5))


### Chores

* bump all packages to 0.2.0 ([938fb0f](https://github.com/emmanuel/durable-xstate/commit/938fb0f3ee269b51da08c7de3b4f6a8894d32d26))
* centralize test DB config, add CI/CD, and add recruiting-pipeline example ([1d109c2](https://github.com/emmanuel/durable-xstate/commit/1d109c25cb1999f9369a014f0d380501593c08bd))
