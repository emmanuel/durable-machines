export type MoveOn = "Passed" | "Completed" | "CompletedAndPassed" | "CompletedOrPassed" | "NotApplicable";
export type LaunchMethod = "OwnWindow" | "AnyWindow";

export interface AUDefinition {
  id: string;
  title: string;
  moveOn: MoveOn;
  masteryScore?: number;
  launchUrl: string;
  launchMethod: LaunchMethod;
}

export interface BlockChild {
  type: "au" | "block";
  id: string;
}

export interface BlockDefinition {
  id: string;
  title: string;
  children: BlockChild[];
}

export interface CourseStructure {
  id: string;
  title: string;
  aus: Record<string, AUDefinition>;
  blocks: Record<string, BlockDefinition>;
  rootChildren: BlockChild[];
}
