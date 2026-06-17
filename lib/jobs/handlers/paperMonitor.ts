import type { JobPayload } from "@/lib/jobs/types";
import { handlerNotImplemented, type JobHandler } from "./types";

type PaperPayload = Extract<JobPayload, { jobType: "paper.monitor" }>;

export const handlePaperMonitor: JobHandler<PaperPayload> = async (payload) => {
  return handlerNotImplemented(
    payload.jobType,
    "paper.monitor needs a closed-bar payload or persisted bar selection policy before worker execution can safely update paper positions",
  );
};
