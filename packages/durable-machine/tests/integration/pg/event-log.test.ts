import { eventLogConformance } from "../../conformance/event-log.js";
import { createPgFixture } from "./fixture.js";

eventLogConformance(createPgFixture());
