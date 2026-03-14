export type AgentStatus = "active" | "scanning" | "idle" | "error";
export type AlertType   = "buy" | "watch" | "warn";
export type ActivityType = "signal" | "scan" | "alert" | "error";

export interface Agent {
  id:          string;
  name:        string;
  status:      AgentStatus;
  focus:       string;
  signalCount: number;
  alertCount:  number;
  lastAction:  string;
}

export interface Alert {
  symbol:     string;
  type:       AlertType;
  message:    string;
  agent:      string;
  confidence: number;
  time:       string;
}

export interface ActivityEntry {
  time:    string;
  type:    ActivityType;
  agent:   string;
  message: string; // may contain HTML spans for ticker highlights
}
