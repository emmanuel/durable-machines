import { lifecycleConformance } from "../../conformance/lifecycle.js";
import { createPgFixture } from "./fixture.js";

lifecycleConformance(createPgFixture());
