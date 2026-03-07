import { promptConformance } from "../../conformance/prompt-channels.js";
import { createPgFixture } from "./fixture.js";

promptConformance(createPgFixture());
