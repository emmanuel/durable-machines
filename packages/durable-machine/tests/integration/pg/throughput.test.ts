import { throughputConformance } from "../../conformance/throughput.js";
import { createPgFixture } from "./fixture.js";

throughputConformance(createPgFixture({ useBatchProcessing: false }));
throughputConformance(createPgFixture());
