/** xAPI Agent — identifies a learner or group. */
export interface XapiAgent {
  name?: string;
  mbox?: string;
  mbox_sha1sum?: string;
  openid?: string;
  account?: { homePage: string; name: string };
  objectType?: "Agent" | "Group";
  member?: XapiAgent[];
  [key: string]: unknown;
}

/** xAPI Verb — the action performed (IRI-identified). */
export interface XapiVerb {
  /** IRI identifying the verb, e.g. `"http://adlnet.gov/expapi/verbs/completed"`. */
  id: string;
  display?: Record<string, string>;
}

/** xAPI Activity — the object of a statement (IRI-identified). */
export interface XapiActivity {
  /** IRI identifying the activity. */
  id: string;
  objectType?: string;
  definition?: {
    name?: Record<string, string>;
    description?: Record<string, string>;
    type?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** xAPI Result — outcome of the experience. */
export interface XapiResult {
  score?: { scaled?: number; raw?: number; min?: number; max?: number };
  completion?: boolean;
  success?: boolean;
  response?: string;
  duration?: string;
  [key: string]: unknown;
}

/** xAPI Context — additional context for a statement. */
export interface XapiContext {
  /** UUID — primary routing field for correlating statements to workflows. */
  registration?: string;
  instructor?: XapiAgent;
  team?: XapiAgent;
  contextActivities?: {
    parent?: XapiActivity[];
    grouping?: XapiActivity[];
    category?: XapiActivity[];
    other?: XapiActivity[];
  };
  [key: string]: unknown;
}

/** xAPI Statement — a single learning experience record. */
export interface XapiStatement {
  /** UUID (may be absent; LRS assigns). */
  id?: string;
  actor: XapiAgent;
  verb: XapiVerb;
  object: XapiActivity;
  result?: XapiResult;
  context?: XapiContext;
  timestamp?: string;
  stored?: string;
  authority?: XapiAgent;
  [key: string]: unknown;
}

/** Normalized payload produced by the xAPI webhook source. */
export interface XapiWebhookPayload {
  statements: XapiStatement[];
  /** Value from `X-Experience-API-Version` header, if present. */
  version?: string;
}
